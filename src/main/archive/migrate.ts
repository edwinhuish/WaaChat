/**
 * 归档迁移：把整个归档库从旧位置搬到新位置。
 *
 * ── 三条不可协商的性质 ──
 *
 *  1. **要么全搬过去，要么回到原样。** 中途失败时把已经搬走的条目搬回来；搬不动的
 *     留在原地**不做删除**。在一个可能持有唯一副本的目录里"顺手删干净"，是这类操作
 *     里最不可原谅的一种写法 —— 宁可让用户看到"两边都有数据"，也不能替他删文件。
 *  2. **不搬派生物。** `.open/` 里的硬链接与 `.part-*` 半成品都能从正文重建（应用
 *     启动时本来就会重建与清扫）。复制它们只会让迁移变慢，而且硬链接复制过去会指向
 *     新的 inode —— 在新位置留下一批看起来正常、实则与正文脱钩的文件。
 *  3. **不阻塞事件循环。** 迁移可能是几十 GB（跨文件系统时会真的复制一遍），因此
 *     文件操作一律走 `node:fs/promises`。用同步 API 会让主进程卡住，界面连同承载
 *     上游页面的那个窗口一起失去响应。
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
import { join } from 'node:path'

import { TEMP_FILE_PREFIX } from '../../shared/constants'
import type {
  ArchiveMigrationProgress,
  MigrationFailure,
  MigrationSummary,
} from '../../shared/types'
import { failureReason } from '../errors'
import { logger } from '../logger'
import { setReadOnly } from './blobs'

/** 索引数据库及其 WAL 附属文件（`-wal` / `-shm`）的名字前缀。 */
const INDEX_PREFIX = '.index.sqlite'

/** 正文的文件名：内容寻址，因此是小写十六进制的 SHA-256（见 `archive/blobs.ts`）。 */
const BLOB_NAME = /^[0-9a-f]{64}$/

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
   * 计划时看到的条目名：正文在前、索引在后（索引描述的是正文）。
   *
   * ⚠️ 其中的**索引**部分只是一份快照，执行时不会被照单搬走 —— 计划算出来的那一刻
   * 索引连接还开着，附属文件（`.index.sqlite-wal` / `-shm`）随后就会被一次干净的关闭
   * 删掉。执行阶段以源目录**当时**的内容为准，理由见文件头的说明。
   */
  readonly entries: readonly string[]
  /** 源目录里可以直接删掉的派生物（`.open/`、`.part-*`）。 */
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
  readonly blobs: readonly string[]
  readonly index: readonly string[]
  readonly disposable: readonly string[]
  readonly bytes: number
}

/**
 * 扫描源目录，把里面的条目分成三类。
 *
 * 遇到搬不了、又不能删的东西（符号链接、非点开头的目录）时**抛错**而不是跳过：
 * 跳过等于"迁移成功"而后用户的文件少了一部分，这比迁移失败严重得多。
 */
function scanSource(dir: string): SourceScan {
  const blobs: string[] = []
  const index: string[] = []
  const disposable: string[] = []
  let bytes = 0

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name

    // 符号链接一律不跟随、不迁移（INVARIANTS G-4：归档目录内不跟随符号链接）。
    if (entry.isSymbolicLink()) throw new MigrationError('unexpected-content', name)
    // 非点开头的目录不该出现在归档目录里 —— 那说明这个目录被别的东西用了。
    if (entry.isDirectory() && !name.startsWith('.'))
      throw new MigrationError('unexpected-content', name)
    if (!entry.isFile() && !entry.isDirectory())
      throw new MigrationError('unexpected-content', name)

    if (entry.isDirectory()) {
      disposable.push(name) // `.open/`
      continue
    }

    if (name.startsWith(INDEX_PREFIX)) {
      index.push(name)
      continue
    }

    if (name.startsWith('.')) {
      disposable.push(name) // `.part-*` 半成品
      continue
    }

    blobs.push(name)
    bytes += statSync(join(dir, name)).size
  }

  return { blobs, index, disposable, bytes }
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
    for (const [index, name] of plan.entries.entries()) {
      if (name.startsWith(INDEX_PREFIX)) continue

      bytesDone += await moveEntry(plan.source, plan.target, name)
      done += 1
      hooks?.afterEntry?.(name, index)
      report('migrating')
    }

    report('finishing')

    for (const name of plan.disposable) {
      await rm(join(plan.source, name), { recursive: true, force: true })
    }

    for (let round = 0; round < MAX_SWEEP_ROUNDS; round += 1) {
      const late = scanSource(plan.source).blobs
      if (late.length === 0) break

      for (const name of late) {
        bytesDone += await moveEntry(plan.source, plan.target, name)
        done += 1
        hooks?.afterEntry?.(name, plan.entries.length)
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

  for (const name of listTargetEntries(plan.target)) {
    // 只碰"我们可能搬过去的东西"。目标目录在计划时被验证为空，理论上里面只有我们的
    // 条目 —— 但"理论上"不能拿来搬用户的东西：这期间恰好被写进目标目录的外来文件，
    // 会被搬进用户的归档目录。宁可把它留在原地（界面本来就提示"请核对两处"）。
    if (!isOwnEntry(name)) continue
    if (existsSync(join(plan.source, name))) continue

    try {
      await moveEntry(plan.target, plan.source, name)
    } catch (error) {
      complete = false
      logger.error('archive: could not move an entry back', { reason: failureReason(error) })
    }
  }

  if (complete) {
    // 只删**空**目录：`rmdir` 在目录非空时抛 ENOTEMPTY。不递归删除是这条路径上
    // 最重要的一条纪律 —— 目标目录里可能有并发写入的东西，也可能有我们没搬回来的。
    await rmdir(plan.target).catch(() => undefined)
  }

  return complete
}

/**
 * 目标目录里的**文件**名。
 *
 * 只列文件：目录（`.open/` 之类）从不会被搬过去，出现就说明那是别的东西，不该由回滚
 * 去动它。目录不存在时返回空列表 —— 回滚可能在任何阶段被调用。
 */
function listTargetEntries(dir: string): string[] {
  if (!existsSync(dir)) return []

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
}

/**
 * 这个名字是不是"归档目录里属于我们的东西"。
 *
 * 归档目录顶层只有三类文件：正文（SHA-256 十六进制名）、索引（`.index.sqlite*`）、
 * 我们自己的临时文件（`.part-*`）。回滚用它把"我们搬过去的"与"别人放进来的"分开。
 */
function isOwnEntry(name: string): boolean {
  return BLOB_NAME.test(name) || name.startsWith(INDEX_PREFIX) || name.startsWith(TEMP_FILE_PREFIX)
}

/**
 * 把一个条目从 `fromDir` 搬到 `toDir`，返回它的字节数。
 *
 * 同一文件系统下 `rename` 是原子且零拷贝的。跨文件系统（用户把归档放到了另一个
 * 挂载点）时退化为"复制到目标里的临时名 → 校验大小 → 改名"，这样目标目录里不会
 * 出现一个看起来完整、实则写了一半的文件。临时名沿用 `.part-` 前缀，因此即使进程
 * 正好死在这里，残留也会被下次启动的 `sweepTempFiles()` 清掉。
 */
async function moveEntry(fromDir: string, toDir: string, name: string): Promise<number> {
  const from = join(fromDir, name)
  const to = join(toDir, name)

  try {
    await rename(from, to)
    return (await stat(to)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }

  const staging = join(toDir, `${TEMP_FILE_PREFIX}migrating-${name}`)

  await copyFile(from, staging)

  const [source, copied] = await Promise.all([stat(from), stat(staging)])
  if (source.size !== copied.size) {
    await rm(staging, { force: true })
    throw new MigrationError('write-failed', name)
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
