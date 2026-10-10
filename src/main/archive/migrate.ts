/**
 * 归档迁移：把整个归档库从旧位置搬到新位置。
 *
 * ── 三条不可协商的性质 ──
 *
 *  1. **要么全搬过去，要么回到原样。** 中途失败时把已经搬走的条目搬回来；搬不动的
 *     留在原地**不做删除**。在一个可能持有唯一副本的目录里"顺手删干净"，是这类操作
 *     里最不可原谅的一种写法 —— 宁可让用户看到"两边都有数据"，也不能替他删文件。
 *  2. **不搬派生物。** `.part-*` 半成品能从正文重建（启动时本来就会清扫）；旧版本的
 *     `.open/` 影子目录（[ADR-0031] 之前为"带原始文件名的硬链接"而建）同理 —— 复制过去
 *     只会留下一批指向新 inode、与正文脱钩的文件。
 *  3. **不阻塞事件循环。** 迁移可能是几十 GB（跨文件系统时会真的复制一遍），因此
 *     文件操作一律走 `node:fs/promises`。用同步 API 会让主进程卡住，界面连同承载
 *     上游页面的那个窗口一起失去响应。
 *
 * ── 分层容器（[ADR-0037] / [ADR-0039] / [ADR-0052]）──
 *
 * 正文在 `<账号>/<消息ID>/files/` 里（历史上还出现过 `<账号>/files/<年-月>/`、
 * `<年-月>/` 与 `<年>/<月>/`），因此搬运的清单是**相对路径**，目标那一侧的同名子目录会被
 * 建出来。两边都要收掉自己留下的**空壳**（源位置搬空之后、回滚之后），否则"搬完了"却删不掉
 * 旧目录，用户看到的是一个空目录树 —— 那与"早就搬干净了"在界面上没法区分。
 *
 * 容器判据在 `containerKind()`：一张"父容器 → 允许的孩子"的转移表。它同时是**安全边界**
 * —— 形状不对的目录（用户自己放进来的）会让整次迁移失败，而不是被当成我们的东西搬走。
 *
 * ── 索引为什么不照计划搬 ──
 *
 * 计划（`planMigration`）是在索引连接**还开着**的时候算出来的，那时目录里除了
 * `.index.sqlite` 还有 `.index.sqlite-wal` / `-shm`；而执行的第一步就是关掉那条连接
 * （ADR-0019 理由 3）。一次干净的关闭会让 SQLite 做 checkpoint 并**删掉**这两个附属
 * 文件，于是"照快照搬"变成搬一个已经不存在的文件 —— `ENOENT`，被记成一次写入失败，
 * 界面上是"磁盘可能已满，或该位置不可写"，而两者其实都不是。因此索引以**执行时**的
 * 目录内容为准（见 migrateArchive 的收尾阶段）。
 *
 * 本模块**不导入 electron，也不导入 `archive/store.ts`** —— 前者是为了能在单测里
 * 直接跑（ai/CONVENTIONS.md 第 3 节），后者是因为 `better-sqlite3` 是原生模块，
 * 顶层导入它会拖慢并可能崩掉测试进程（见 test/unit/store.test.ts 的说明）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { copyFile, mkdir, rename, rmdir, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { TEMP_FILE_PREFIX } from '../../shared/constants'
import type {
  ArchiveMigrationProgress,
  MigrationFailure,
  MigrationSummary,
} from '../../shared/types'
import { failureReason } from '../errors'
import { logger } from '../logger'
import { accountKey } from '../paths'
import { setReadOnly } from './blobs'
import {
  FILES_SEGMENT,
  isAccountSegment,
  isArchiveMonthDir,
  isLegacyMonthDir,
  isLegacyYearDir,
  isMessageSegment,
} from './layout'

/** 索引数据库及其 WAL 附属文件（`-wal` / `-shm`）的名字前缀。 */
const INDEX_PREFIX = '.index.sqlite'

/**
 * 这个相对路径是不是归档**根**下的索引文件。
 *
 * `includes('/')` 那一半不能省：年月目录里的文件是正文，哪怕它恰好叫 `.index.sqlite`
 * —— 只按前缀认的话，它会被当成索引跳过不搬，迁移随后报"源目录非空"。
 */
function isIndexEntry(relative: string): boolean {
  return !relative.includes('/') && relative.startsWith(INDEX_PREFIX)
}

/**
 * 并发兜底的最多轮数。
 *
 * 迁移期间用户可能正好点开一个文件，而它的临时文件与最终位置都还在旧目录。
 * 每轮重新扫一遍源目录，把新出现的正文一起搬走；轮数有上限是为了不让一个持续写入的
 * 进程把我们困在循环里 —— 剩下的会在下一次迁移或用户手工处理时解决。
 */
const MAX_SWEEP_ROUNDS = 3

/** 目标目录权限。与归档目录一致：里面是解密后的明文。 */
const DIR_MODE = 0o700

/** 携带结构化原因的失败。执行阶段捕获它，保留"为什么失败"而不是一个字符串。 */
class MigrationError extends Error {
  readonly failure: MigrationFailure
  readonly detail: string

  constructor(failure: MigrationFailure, detail: string) {
    super(`${failure}: ${detail}`)
    this.name = 'MigrationError'
    this.failure = failure
    this.detail = detail
  }
}

export interface MigrationPlan {
  readonly source: string
  readonly target: string
  /**
   * 计划时看到的条目**相对源目录的路径**（`2026/10/合同.pdf` 或旧平面的 `合同.pdf`）：
   * 正文在前、索引在后（索引描述的是正文）。
   *
   * ⚠️ 其中的**索引**部分只是一份快照，执行时不会被照单搬走 —— 计划算出来的那一刻
   * 索引连接还开着，附属文件（`.index.sqlite-wal` / `-shm`）随后就会被一次干净的关闭
   * 删掉。执行阶段以源目录**当时**的内容为准，理由见文件头的说明。
   */
  readonly entries: readonly string[]
  /** 源目录里可以直接删掉的派生物（`.part-*` 半成品、旧版本的 `.open/` 影子目录）。 */
  readonly disposable: readonly string[]
  readonly summary: MigrationSummary
}

export type MigrationPlanOutcome =
  | { readonly ok: true; readonly plan: MigrationPlan }
  | { readonly ok: false; readonly failure: MigrationFailure; readonly detail: string }

export type MigrationOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly failure: MigrationFailure
      readonly detail: string
      readonly rolledBack: boolean
    }

export interface MigrationHooks {
  /**
   * **仅供测试注入故障**：每搬完一个条目调用一次，抛错即模拟写盘失败。
   *
   * 回滚这条路径必须被真实覆盖 —— 而"让第二个条目恰好失败"在不注入故障的前提下
   * 只能靠 chmod 之类的环境把戏，那些在 root 或异地文件系统下会静默失效，于是回滚
   * 测试会变成"永远通过"。
   */
  readonly afterEntry?: (name: string, index: number) => void
}

// ---------------------------------------------------------------------------
// 计划
// ---------------------------------------------------------------------------

interface SourceScan {
  /**
   * 正文，**相对源目录的路径**：平面布局是 `合同.pdf`，
   * 年月布局是 `2026/10/合同.pdf`（[ADR-0037]）。
   */
  readonly blobs: readonly string[]
  readonly index: readonly string[]
  readonly disposable: readonly string[]
  readonly bytes: number
}

/**
 * 扫描源目录，把里面的条目分成三类。
 *
 * 归档目录里只允许出现这几样东西，其余一律**抛错**而不是跳过 —— 跳过等于"迁移成功"而后
 * 用户的文件少了一部分，那比迁移失败严重得多：
 *
 *   1. 正文（根下的非点开头文件；或下面任何一种容器里的文件）
 *   2. 索引（根下的 `.index.sqlite*`）
 *   3. 我们自己的派生物（根下的 `.part-*`，或点开头的目录 `.open/`）
 *   4. **我们写下的容器**，逐个历史版本都要认（[ADR-0037] / [ADR-0039] / [ADR-0052]）：
 *        `<账号>/<消息ID>/files/`  ← 现在
 *        `<账号>/files/<年-月>/`   ← ADR-0039
 *        `<年-月>/`                ← ADR-0037 之后、ADR-0039 之前的月份目录
 *        `<年>/<月>/`              ← ADR-0037 当时的两层
 *      形状不对（例如 `stuff/`）仍然是异常 —— 那说明归档目录被别的东西用了。
 *
 * 符号链接一律不跟随、不迁移（INVARIANTS G-4）。
 */
function scanSource(dir: string): SourceScan {
  const blobs: string[] = []
  const index: string[] = []
  const disposable: string[] = []
  let bytes = 0

  const walk = (abs: string, prefix: string, parent: ContainerKind): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const name = entry.name
      const relative = prefix === '' ? name : `${prefix}/${name}`

      if (entry.isSymbolicLink()) throw new MigrationError('unexpected-content', relative)

      if (entry.isDirectory()) {
        // 点开头的目录（`.open/`）是旧版本的派生物，删掉即可。
        if (parent === 'root' && name.startsWith('.')) {
          disposable.push(name)
          continue
        }

        const kind = containerKind(parent, name)
        if (kind === null) throw new MigrationError('unexpected-content', relative)

        walk(join(abs, name), relative, kind)
        continue
      }

      if (!entry.isFile()) throw new MigrationError('unexpected-content', relative)

      // 索引与临时文件只可能落在归档根。
      if (parent === 'root') {
        if (name.startsWith(INDEX_PREFIX)) {
          index.push(name)
          continue
        }

        if (name.startsWith('.')) {
          disposable.push(name) // `.part-*` 半成品
          continue
        }
      }

      blobs.push(relative)
      bytes += statSync(join(abs, name)).size
    }
  }

  walk(dir, '', 'root')

  return { blobs, index, disposable, bytes }
}

/**
 * 我们写下的容器种类（按父容器决定下一层允许什么）。
 *
 * `legacy-files` 与 `message-files` 都是名为 `files` 的目录，但**父容器不同、含义不同**
 * （前者是 [ADR-0039] 的 `<账号>/files/<年-月>/`，后者是 [ADR-0052] 的
 * `<账号>/<消息ID>/files/`），因此拆成两种：混成一种就分不清 `files` 下面该出现月份
 * 还是正文。
 */
type ContainerKind =
  | 'root'
  | 'account'
  | 'message'
  | 'legacy-files'
  | 'message-files'
  | 'month'
  | 'legacy-year'
  | 'legacy-month'

/**
 * `parent` 里出现一个叫 `name` 的目录，它算不算**我们的**容器；算的话是哪一种。
 *
 * 这一张转移表是迁移能"认出自己写下的所有布局、又不把别人的目录搬走"的全部依据：
 * 每一层只接受它该有的那一种孩子。
 */
function containerKind(parent: ContainerKind, name: string): ContainerKind | null {
  switch (parent) {
    case 'root':
      if (isAccountSegment(name, accountKey())) return 'account'
      if (isArchiveMonthDir(name)) return 'month'
      return isLegacyYearDir(name) ? 'legacy-year' : null

    case 'account':
      // 旧布局 `<账号>/files/<年-月>/…`（[ADR-0039]）与新布局
      // `<账号>/<消息ID>/files/…`（[ADR-0052]）在这一层靠 `files` 这个名字分开。
      if (name === FILES_SEGMENT) return 'legacy-files'
      return isMessageSegment(name) ? 'message' : null

    case 'message':
      return name === FILES_SEGMENT ? 'message-files' : null

    case 'legacy-files':
      return isArchiveMonthDir(name) ? 'month' : null

    case 'legacy-year':
      return isLegacyMonthDir(name) ? 'legacy-month' : null

    // 月份目录与消息的 `files` 目录里只有正文 —— 再出现目录就是异常。
    default:
      return null
  }
}

/**
 * 目标位置是否可用。
 *
 * 三条都要挡：不能是源本身、不能是源的子目录（复制会自我递归）、也不能是源的上级
 * （源就在目标里，搬完等于没搬）。比较时补上结尾的 `/`，否则 `/a/bc` 会被误判成
 * `/a/b` 的子目录。
 *
 * 导出它是为了让 `scripts/check-capture.ts` 能离线断言这条判据 —— 它不需要文件系统，
 * 是纯字符串比较。
 */
export function isAllowedTarget(source: string, target: string): boolean {
  if (source === target) return false

  const sourcePrefix = source.endsWith('/') ? source : `${source}/`
  const targetPrefix = target.endsWith('/') ? target : `${target}/`

  return !targetPrefix.startsWith(sourcePrefix) && !sourcePrefix.startsWith(targetPrefix)
}

/**
 * 检查目标、扫描源，产出一份可执行的计划。
 *
 * 计划必须在**用户确认之前**算出来：确认框里要写清"会把多少个文件（多大的量）
 * 搬到哪里"，而算出它需要先确认目标可用 —— 否则用户可能先点了"确认"再被告知
 * "这个目录不行"。
 */
export function planMigration(source: string, target: string): MigrationPlanOutcome {
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    return { ok: false, failure: 'source-missing', detail: source }
  }

  if (!isAllowedTarget(source, target)) {
    return { ok: false, failure: 'nested-location', detail: `${source} ↔ ${target}` }
  }

  let scan: SourceScan
  try {
    scan = scanSource(source)
  } catch (error) {
    return asFailure(error)
  }

  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) {
      return { ok: false, failure: 'not-a-directory', detail: target }
    }
    // 归档是内容寻址的**单一**库，不做合并：两个假名不同的索引合在一起要逐条重写，
    // 而"哪个记录属于哪份文件"没有可靠的判据。宁可让用户选一个空目录。
    if (readdirSync(target).length !== 0) {
      return { ok: false, failure: 'target-not-empty', detail: target }
    }
  }

  return {
    ok: true,
    plan: {
      source,
      target,
      entries: [...scan.blobs, ...scan.index],
      disposable: scan.disposable,
      summary: { files: scan.blobs.length, bytes: scan.bytes },
    },
  }
}

function asFailure(error: unknown): { ok: false; failure: MigrationFailure; detail: string } {
  if (error instanceof MigrationError) {
    return { ok: false, failure: error.failure, detail: error.detail }
  }

  // 未预期的错误不该被伪装成"迁移失败的具体原因"：它要么是 bug，要么环境问题。
  throw error
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/**
 * 执行迁移。
 *
 * 返回失败时，**已经完成的搬运已被撤销**（`rolledBack`），或者明确告诉调用方撤销
 * 没成功。注意这个函数不负责"切换设置"——那是调用方的事，因为"数据搬完了但设置
 * 没落盘"同样需要回滚，而只有调用方知道怎么回滚设置（见 `archive/relocate.ts`）。
 */
export async function migrateArchive(
  plan: MigrationPlan,
  onProgress: (progress: ArchiveMigrationProgress) => void,
  hooks?: MigrationHooks,
): Promise<MigrationOutcome> {
  const total = plan.entries.length
  let done = 0
  let bytesDone = 0

  const report = (phase: ArchiveMigrationProgress['phase']): void => {
    onProgress({ phase, done, total, bytesDone, bytesTotal: plan.summary.bytes })
  }

  report('migrating')

  try {
    await mkdir(plan.target, { recursive: true, mode: DIR_MODE })

    // 正文照计划搬；索引留到收尾阶段，那时按源目录的**实际内容**再枚举一次
    // （理由见文件头与下面的收尾阶段）。
    for (const [index, relative] of plan.entries.entries()) {
      if (isIndexEntry(relative)) continue

      bytesDone += await moveEntry(plan.source, plan.target, relative)
      done += 1
      hooks?.afterEntry?.(relative, index)
      report('migrating')
    }

    report('finishing')

    for (const name of plan.disposable) {
      await rm(join(plan.source, name), { recursive: true, force: true })
    }

    for (let round = 0; round < MAX_SWEEP_ROUNDS; round += 1) {
      const late = scanSource(plan.source).blobs
      if (late.length === 0) break

      for (const relative of late) {
        bytesDone += await moveEntry(plan.source, plan.target, relative)
        done += 1
        hooks?.afterEntry?.(relative, plan.entries.length)
        report('finishing')
      }
    }

    // 索引最后搬：它描述的是正文，正文没到位之前搬过去没有意义。而且它的清单只能
    // 在**这一刻**才作数 —— 计划时看到的附属文件（`.index.sqlite-wal` / `-shm`）已经
    // 被 `closeArchiveStore()` 顺带删掉了。
    for (const name of scanSource(plan.source).index) {
      // 目标里已经有同名文件 ⇒ 它已经被搬过去过一次，源目录里这份是迁移窗口里新建的
      // （空库）。覆盖等于用空库盖掉真库 —— ADR-0019 不做索引合并，宁可让旧位置多留
      // 一个空库（界面会提示核对两处），也不动新位置里那份完整的索引。
      if (existsSync(join(plan.target, name))) continue

      bytesDone += await moveEntry(plan.source, plan.target, name)
      done += 1
      report('finishing')
    }

    // 正文搬空之后，源目录里会留下一批**空的**年月子目录（[ADR-0037]），先收掉它们，
    // 否则下面的 `rmdir` 会因为源目录非空而失败 —— 旧位置于是留下一个空壳目录树。
    await removeEmptyDirs(plan.source)

    // 源目录空了才删它；没空说明还有东西搬不走，留着让用户看得见。
    await removeIfEmpty(plan.source)

    return { ok: true }
  } catch (error) {
    const rolledBack = await rollbackMigration(plan)
    const failure = error instanceof MigrationError ? error.failure : 'write-failed'
    const detail = error instanceof MigrationError ? error.detail : failureReason(error)

    // ⚠️ 不记 `detail`：它可能包含完整路径（G-3）。界面上会显示它，日志里不会。
    logger.error('archive: migration failed', {
      failure,
      rolledBack,
      reason: failureReason(error),
    })
    return { ok: false, failure, detail, rolledBack }
  }
}

/**
 * 把已经搬到新位置的条目搬回原位。
 *
 * 判据是"新位置有、原位置没有"的条目才需要搬回 —— 因此它是**幂等**的，可以在任意
 * 时刻重跑（迁移中途失败、或"数据搬完但设置没落盘"）。
 *
 * 清单取自**目标目录本身**，而不是计划里的快照：执行阶段搬过去的东西里，索引是按
 * 执行时的实际情况枚举的，收尾的多轮扫描还可能补搬几个迟到的正文 —— 它们都不在计划
 * 里。用一份过期的快照回滚，结果是"回滚成功"而新位置里还留着一个我们搬过去的文件，
 * 那正是这条路径上最不该出现的报告。
 *
 * ⚠️ **只做搬运，不删数据以外的任何东西。** 唯一允许删除的是最后那个空的、由我们
 * 创建的目标目录。搬不回去的条目原样留在新位置，函数返回 `false`，让界面告诉用户
 * 去人工核对 —— 这是"回滚失败"唯一诚实的表达方式。
 */
export async function rollbackMigration(plan: MigrationPlan): Promise<boolean> {
  let complete = true

  // 源目录可能已经被删掉了（迁移成功后的收尾），搬回之前要先把它建回来。
  await mkdir(plan.source, { recursive: true, mode: DIR_MODE }).catch(() => undefined)

  for (const relative of listTargetEntries(plan.target)) {
    // 只碰"我们可能搬过去的东西"。目标目录在计划时被验证为空，理论上里面只有我们的
    // 条目 —— 但"理论上"不能拿来搬用户的东西：这期间恰好被写进目标目录的外来文件，
    // 会被搬进用户的归档目录。宁可把它留在原地（界面本来就提示"请核对两处"）。
    if (!isOwnEntry(relative)) continue
    if (existsSync(join(plan.source, relative))) continue

    try {
      await moveEntry(plan.target, plan.source, relative)
    } catch (error) {
      complete = false
      logger.error('archive: could not move an entry back', { reason: failureReason(error) })
    }
  }

  if (complete) {
    // 年月子目录会随着里面的文件被搬空而留下来（[ADR-0037]），先自底向上收掉空目录；
    // 否则最后那次 `rmdir(plan.target)` 会因为目标目录非空而失败。
    await removeEmptyDirs(plan.target)

    // 只删**空**目录：`rmdir` 在目录非空时抛 ENOTEMPTY。不递归删除是这条路径上
    // 最重要的一条纪律 —— 目标目录里可能有并发写入的东西，也可能有我们没搬回来的。
    await rmdir(plan.target).catch(() => undefined)
  }

  return complete
}

/**
 * 自底向上删掉目录树里的**空**目录（不含根）。
 *
 * 用 `rmdir` 而不是 `rm -r`：`rmdir` 在目录非空时抛 `ENOTEMPTY`，这正是我们要的 ——
 * 里面还有搬不走的东西（或者根本不是我们的目录）就留着它，让用户看得见。删不掉一律
 * 忽略：这一步只是为了清掉自己留下的空壳，失败不影响"回滚是否成功"这个结论。
 */
async function removeEmptyDirs(dir: string): Promise<void> {
  if (!existsSync(dir)) return

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue

    const child = join(dir, entry.name)
    await removeEmptyDirs(child)
    await rmdir(child).catch(() => undefined)
  }
}

/**
 * 目标目录里的**文件**（相对路径，含年月子目录那一段）。
 *
 * 只列文件：目录（年月容器、`.open/` 之类）本身不会被搬来搬去，出现就说明那是别的东西，
 * 不该由回滚去动它。点开头的目录不进去（`.open/` 从不会被搬过去）。目录不存在时返回空
 * 列表 —— 回滚可能在任何阶段被调用。
 */
function listTargetEntries(dir: string): string[] {
  if (!existsSync(dir)) return []

  const entries: string[] = []

  const walk = (abs: string, prefix: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`

      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) walk(join(abs, entry.name), relative)
        continue
      }

      if (entry.isFile()) entries.push(relative)
    }
  }

  walk(dir, '')

  return entries
}

/**
 * 这个相对路径是不是"归档目录里属于我们的东西"。
 *
 * 我们的东西只有几类：正文（根下的非点开头文件，或下面任何一种容器里的文件）、索引
 * （根下的 `.index.sqlite*`）、我们自己的临时文件（根下的 `.part-*`）、以及承载正文的
 * **我们写下的容器** —— `<账号>/<消息ID>/files/`（[ADR-0052]）、`<账号>/files/<年-月>/`
 * （[ADR-0039]）、`<年-月>/`、`年/月/`（[ADR-0037]）。回滚用它把"我们搬过去的"与
 * "别人放进来的"分开。
 *
 * 新布局只把顶层那一段（`<账号>`）拿来看就够了：账号目录以下的 `<消息ID>/files/` 与
 * 旧布局的 `files/<年-月>/` 都在同一个顶层容器里，必然一起搬。
 *
 * 正文在 [ADR-0031] 之后用**原文名**，没有可判定的名字形态了 —— 因此根下的判据只能放宽成
 * "非点开头"（点开头的只剩索引与临时文件，那两类按前缀认掉）。为什么选择放宽而不是收紧：
 * 两个方向的错误不对称。**漏搬**一个我们自己的文件会让回滚**谎报成功**，而文件其实留在
 * 新位置；错搬一个外来文件只是让用户在两个位置都看到它（界面本来就提示"请核对两处"）。
 * 另有两道更早的防线：目标目录在计划时必须为空、源目录里已有同名文件就跳过。
 */
function isOwnEntry(relative: string): boolean {
  const segments = relative.split('/')

  if (segments.length === 1) {
    const name = segments[0] ?? ''
    if (name.startsWith(INDEX_PREFIX) || name.startsWith(TEMP_FILE_PREFIX)) return true

    return !name.startsWith('.')
  }

  // 深处的前缀只可能是我们写下的某一种容器 —— 逐个历史版本都认（见 scanSource）：
  // `<账号>/…`、`<年-月>/…`（ADR-0039 之后）、`<年>/…`（ADR-0037 当时）。
  const head = segments[0] ?? ''

  return isAccountSegment(head, accountKey()) || isArchiveMonthDir(head) || isLegacyYearDir(head)
}

/**
 * 把一个条目从 `fromDir` 搬到 `toDir`，返回它的字节数。
 *
 * @param relative 相对源目录的路径，可能带年月子目录（`2026/10/合同.pdf`，[ADR-0037]）——
 *   目标那一侧的同名子目录会被建出来（`0700`）。
 *
 * 同一文件系统下 `rename` 是原子且零拷贝的。跨文件系统（用户把归档放到了另一个
 * 挂载点）时退化为"复制到目标里的临时名 → 校验大小 → 改名"，这样目标目录里不会
 * 出现一个看起来完整、实则写了一半的文件。临时名沿用 `.part-` 前缀，因此即使进程
 * 正好死在这里，残留也会被下次启动的 `sweepTempFiles()` 清掉。
 */
async function moveEntry(fromDir: string, toDir: string, relative: string): Promise<number> {
  const from = join(fromDir, relative)
  const to = join(toDir, relative)

  // 目标那一侧的年月子目录可能还不存在（跨设备复制到新位置、或回滚到刚重建的空目录）。
  await mkdir(dirname(to), { recursive: true, mode: DIR_MODE })

  try {
    await rename(from, to)
    return (await stat(to)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }

  /**
   * 临时名落在目标目录**根**（`sweepTempFiles()` 只扫根），因此要把路径压平成
   * 一段文件名 —— 否则 `join(toDir, '.part-migrating-2026/10/x.pdf')` 会在还不存在
   * 的子目录里创建文件。
   */
  const staging = join(toDir, `${TEMP_FILE_PREFIX}migrating-${relative.replaceAll('/', '_')}`)

  await copyFile(from, staging)

  const [source, copied] = await Promise.all([stat(from), stat(staging)])
  if (source.size !== copied.size) {
    await rm(staging, { force: true })
    throw new MigrationError('write-failed', relative)
  }

  await rename(staging, to)
  await unlink(from)

  // `rename` 一定保留权限位，跨设备那条 `copyFile` 分支不一定 —— 把"正文只读"补回来
  // （[ADR-0031]）。幂等，且失败只记日志。
  setReadOnly(to)

  return copied.size
}

/**
 * 删掉一个空目录。
 *
 * 用 `rmdir` 而不是 `rm(path, { recursive: false })`：后者在新版 Node 上对目录会抛
 * `ERR_FS_EISDIR`（它按文件处理），而 `rmdir` 的语义正是"删空目录" —— 非空时抛
 * ENOTEMPTY。源目录里如果还有搬不走的东西，就让它留着，让用户看得见。
 */
async function removeIfEmpty(dir: string): Promise<void> {
  await rmdir(dir).catch(() => undefined)
}
