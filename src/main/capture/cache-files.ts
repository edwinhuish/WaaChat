/**
 * 密文缓存的**磁盘侧**：条目形态、残留判定、转换（切换）与对账。
 *
 * 为什么不写在 `capture/protocol.ts` 里：那里 import electron（`net` / `Session`），而
 *
 *   - 转换与对账发生在会话建立**之前**（或与拦截无关的时刻），和"拦截请求"是两件事；
 *   - 单测与离线自检都进不去带 electron 的模块（ai/CONVENTIONS.md 第 8 节）。
 *
 * 因此把"条目长什么样、目录该怎么收拾"放在这里，协议层只留拦截。
 *
 * 缓存是纯派生数据：[ADR-0008] 把它列为"可随时安全删除" —— 本模块的对账就是这句话的
 * 落点。它处理的始终是**密文的字节**，不是它的含义，因此这里不该出现任何密钥、
 * 派生或加解密代码（[INV-3]）。
 *
 * ── 两种"收拾"必须分清 ──
 *
 *   `reconcileCiphertextCache()`  启动时按设置对账（兜底：崩溃恢复 + 把设置贯彻到底）
 *   `convertCache()`              用户拨动开关时发起的一次**切换**（静默、事务式，可回退）
 *
 * 前者幂等、无状态、每次启动都跑；后者是一次性动作，成败由 [ADR-0027] 定义。
 */

import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  type Dirent,
  type Stats,
} from 'node:fs'
import { mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { folderFor, isAccountSegment, isArchiveMonthDir } from '../archive/layout'
import { failureReason } from '../errors'
import { logger } from '../logger'
import { accountKey, ciphertextAccountDir, ciphertextCacheDir } from '../paths'

/** 目录权限：缓存里是密文，危害低于归档，但仍不放宽。 */
export const CACHE_DIR_MODE = 0o700

/** 正文的文件名后缀。 */
export const BODY_SUFFIX = '.bin'

/**
 * 与正文一起保存的元信息后缀。
 *
 * ⚠️ 这两个后缀属于**磁盘格式**：`docs/security.md` 第 2 节就是按"正文 + 一份只含响应头
 * 白名单的 `.meta.json`"来描述 `cache/` 里的内容的。改它们等于改格式。
 */
export const META_SUFFIX = '.meta.json'

/**
 * 缓存条目的格式版本。
 *
 * "回放时要带上哪些响应头"属于**语义**（见 `capture/headers.ts` 与 [ADR-0016]）。语义一变就
 * 必须让旧条目失效，否则用户机器上那些按旧语义写下的条目会继续被回放 —— 症状是"只在
 * 老用户那里复现的页面损坏"，最难查的一类问题。版本不符按未命中处理：重新回源即可自愈。
 *
 * 3 = 条目从"缓存根下平铺"改成 `<账号>/<年-月>/`（[ADR-0039]）。路径变了，旧条目再也
 * 命不中，因此它们在启动对账时**整批删掉**（见 `reconcileCiphertextCache`）—— 缓存是
 * 纯派生数据（[ADR-0008]），删了只影响速度。
 *
 * ⚠️ `capture/headers.ts` 的白名单一变，这里**必须**加一（`ai/TASKS.md`）。
 */
export const CACHE_VERSION = 3

/**
 * 转换期间的暂存区（相对缓存目录）。
 *
 * 关闭缓存时，条目**先搬到这里**而不是直接删：需求要求"失败或中断就回到切换前的状态"，
 * 而删除是不可逆的。同目录内的 `rename` 原子、同文件系统因此不复制字节、几乎瞬时。
 *
 * 以点开头：`isEntryName()` 不认它，因此对账永远把它当"不是我们的东西"，不会误删、
 * 也不会误算成缓存条目。
 */
export const STAGING_DIR_NAME = '.staging'

/** 一个条目的两个文件。 */
export function cacheEntryPaths(dir: string, id: string): { body: string; meta: string } {
  return { body: join(dir, `${id}${BODY_SUFFIX}`), meta: join(dir, `${id}${META_SUFFIX}`) }
}

/**
 * 暂存区：**与本月条目同目录**的 `.staging/`（`<账号>/<年-月>/.staging`）。
 *
 * 放同目录是刻意的：切换（[ADR-0027]）用 `rename` 搬条目，同目录因此不跨文件系统、也不
 * 复制字节 —— 而且**搬回去时知道该回哪个月份目录**（[ADR-0039] 之后条目按月份分目录，
 * 一个账号级的暂存区做不到这件事：回滚会把文件散落到账号目录下）。
 */
export function stagingDir(dir: string = currentCacheMonthDir()): string {
  return join(dir, STAGING_DIR_NAME)
}

/** 一个目录里的子目录名（读不到就是空 —— 目录还不存在是正常情况）。 */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * 缓存根下的**账号目录**（[ADR-0039]）。
 *
 * 判据与归档那边同源（`isAccountSegment`）：只认 UUID 形状、`unknown-account` 与当前生效的
 * 账号名。`cache/` 下出现别的目录说明那里被别的东西用了（或是一次失败的手工整理），
 * 我们不去动它 —— 那也正是"清除缓存"不会误伤别人的东西的原因。
 */
export function cacheAccountDirs(root: string = ciphertextCacheDir()): string[] {
  return subdirs(root)
    .filter((name) => isAccountSegment(name, accountKey()))
    .map((name) => join(root, name))
}

/** 缓存里**所有**条目目录（`<账号>/<年-月>`）—— 切换与对账都按它遍历。 */
export function cacheEntryDirs(root: string = ciphertextCacheDir()): string[] {
  return cacheAccountDirs(root).flatMap((accountDir) => cacheMonthDirs(accountDir))
}

/** 某个账号目录下的**月份目录**，新的在前（名字 `YYYY-MM` 的字典序就是时间序）。 */
export function cacheMonthDirs(accountDir: string = ciphertextAccountDir()): string[] {
  return subdirs(accountDir)
    .filter((name) => isArchiveMonthDir(name))
    .sort()
    .reverse()
    .map((name) => join(accountDir, name))
}

/** 写入用的当月目录（不一定存在 —— `persist` 会建）。 */
export function currentCacheMonthDir(accountDir: string = ciphertextAccountDir()): string {
  return join(accountDir, folderFor(Date.now()))
}

/**
 * 按内容键找**已有的**条目，跨月份（可能在上个月写下）。
 *
 * 只做 `statSync`：月份目录数是个位数量级，而每个请求都要走这里，因此**不做全盘扫描**
 * （`readdirSync` 每个请求一次也不是不行，但没必要）。返回 `null` 表示没有可命中的条目。
 */
export function findCacheEntry(
  id: string,
  accountDir: string = ciphertextAccountDir(),
): { body: string; meta: string } | null {
  for (const dir of cacheMonthDirs(accountDir)) {
    const paths = cacheEntryPaths(dir, id)
    if (existsSync(paths.body) && existsSync(paths.meta)) return paths
  }

  return null
}

/** 文件名是不是**我们写的**条目（正文或元信息）。不认识的扩展名一律不算。 */
export function isEntryName(name: string): boolean {
  return name.endsWith(BODY_SUFFIX) || name.endsWith(META_SUFFIX)
}

/**
 * 目录里哪些名字是"不可能再被命中的残留"。
 *
 * 判据只有一条：**成对才算一个条目**。回放时要同时读正文与元信息（`protocol.ts` 的
 * `readCached`），缺任何一个都读不出来，因此单边文件永远命不中 —— 它只占磁盘。
 * 进程被 kill 在"正文写完、元信息还没写"之间留下的正是这种半成品。
 *
 * 不认识的扩展名一律**留着**：这个目录是应用自己的，但"不认识就删"是一条不该有的习惯。
 *
 * 刻意**不**在这里判断元信息的版本：那要读一遍所有 `.meta.json`（缓存上限 2 GiB，条目
 * 可能上万），而版本不符的条目会在同一个 URL 再次请求时被**原地覆盖**（键不变，写的
 * 是同一个文件名），自己就好了。
 *
 * 纯函数 —— 输入就是 `readdir` 的名字列表，因此可以直接单测。
 */
export function orphanEntries(names: readonly string[]): string[] {
  const present = new Set(names)
  const orphans: string[] = []

  for (const name of names) {
    if (name.endsWith(META_SUFFIX)) {
      if (!present.has(name.slice(0, -META_SUFFIX.length) + BODY_SUFFIX)) orphans.push(name)
      continue
    }

    if (name.endsWith(BODY_SUFFIX)) {
      if (!present.has(name.slice(0, -BODY_SUFFIX.length) + META_SUFFIX)) orphans.push(name)
    }
  }

  return orphans
}

// ---------------------------------------------------------------------------
// 目录读取（对账与转换共用）
// ---------------------------------------------------------------------------

type FilesResult =
  | { readonly ok: true; readonly files: readonly string[] }
  | { readonly ok: false; readonly detail: string }

/** 缓存目录里的普通文件名。目录不存在时是空列表；读不了时带上 errno。 */
function regularFiles(dir: string): FilesResult {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    // 目录不存在（还没开过缓存的新机器）是正常情况，不是错误。
    if (!existsSync(dir)) return { ok: true, files: [] }

    return { ok: false, detail: failureReason(error) }
  }

  return { ok: true, files: entries.filter((entry) => entry.isFile()).map((entry) => entry.name) }
}

/** 我们写的条目文件里，这一次切换要处理的那些（关闭 = 全部；开启 = 只剩残留）。 */
function targetEntries(dir: string, target: boolean): FilesResult {
  const listed = regularFiles(dir)
  if (!listed.ok) return listed

  const ours = listed.files.filter(isEntryName)
  return { ok: true, files: target ? orphanEntries(ours) : ours }
}

/** 这些文件的字节数。读不到某个文件时按 0 算 —— 它只用于确认框里的量级与进度。 */
function totalBytes(dir: string, names: readonly string[]): number {
  let bytes = 0
  for (const name of names) {
    try {
      bytes += statSync(join(dir, name)).size
    } catch {
      continue
    }
  }
  return bytes
}

// ---------------------------------------------------------------------------
// 一次切换（事务式维护流程，ADR-0027）
// ---------------------------------------------------------------------------

export interface CacheConversionPlan {
  /** 目标状态：`true` 开启、`false` 关闭。 */
  readonly target: boolean
  /** 要处理的条目文件数。 */
  readonly entries: number
  readonly bytes: number
}

export type CacheConversionPlanResult =
  | { readonly ok: true; readonly plan: CacheConversionPlan }
  | { readonly ok: false; readonly detail: string }

/**
 * 算一次切换要处理多少东西（**所有**账号 × 所有月份目录）。
 *
 * 必须在**动手之前**算出来：确认框要写清楚"将清掉 N 个文件（X）"，而不是先让用户确认、
 * 再告诉他规模。读不到目录时 `ok: false` —— 此时不该开始切换。
 */
export function planCacheConversion(target: boolean): CacheConversionPlanResult {
  let entries = 0
  let bytes = 0

  for (const dir of cacheEntryDirs()) {
    const listed = targetEntries(dir, target)
    if (!listed.ok) return { ok: false, detail: listed.detail }

    entries += listed.files.length
    bytes += totalBytes(dir, listed.files)
  }

  return { ok: true, plan: { target, entries, bytes } }
}

export type CacheConversionOutcome =
  | { readonly ok: true; readonly converted: number; readonly bytes: number }
  | { readonly ok: false; readonly detail: string; readonly rolledBack: boolean }

export interface CacheConversionHooks {
  /**
   * 每处理完一个条目调用一次。存在的唯一理由是让测试能注入失败 ——
   * 系统里没法稳定地让"第 3 个 `rename` 失败"真实发生（与 `archive/migrate.ts` 同款）。
   */
  afterEntry?(name: string, index: number): void
}

/**
 * 执行转换。**只搬/删文件，不碰设置** —— 提交由调用方在全部成功之后做。
 *
 * - **关闭**：把条目搬进暂存区。任何一步失败就把已搬走的搬回原位再返回失败 ——
 *   这是"回退到切换前的原始状态"能成立的前提。
 * - **开启**：删掉不可能命中的残留。这些文件本来就永远命不中（缺一半、读不出来），
 *   删除不可逆但**没有可丢的东西**，因此失败时不需要回退（设置也不会被提交）。
 *
 * 逐条 `await`：缓存上限是 2 GiB、条目可能上万，用同步 API 会把主进程连同界面一起卡住
 * （与 `archive/migrate.ts` 同一条理由）。
 */
export async function convertCache(
  plan: CacheConversionPlan,
  hooks?: CacheConversionHooks,
): Promise<CacheConversionOutcome> {
  const work: { dir: string; names: readonly string[] }[] = []

  for (const dir of cacheEntryDirs()) {
    const listed = targetEntries(dir, plan.target)
    if (!listed.ok) return { ok: false, detail: listed.detail, rolledBack: true }

    work.push({ dir, names: listed.files })
  }

  let done = 0
  let bytesDone = 0

  try {
    if (!plan.target) {
      for (const { dir } of work) {
        await mkdir(stagingDir(dir), { recursive: true, mode: CACHE_DIR_MODE })
      }
    }

    for (const { dir, names } of work) {
      // 暂存区就在**这个月份目录**里：`rename` 同目录、零拷贝，而且回滚时知道回哪个月份。
      const staging = stagingDir(dir)

      for (const [index, name] of names.entries()) {
        const path = join(dir, name)
        const size = fileBytes(path)

        if (plan.target) {
          await rm(path)
        } else {
          await rename(path, join(staging, name))
        }

        done += 1
        bytesDone += size
        hooks?.afterEntry?.(name, index)
      }
    }

    return { ok: true, converted: done, bytes: bytesDone }
  } catch (error) {
    const detail = failureReason(error)

    // 关闭方向的失败必须把已经搬走的东西搬回来 —— 否则设置说"还开着"，缓存却少了一批。
    let rolledBack = true
    if (!plan.target) {
      for (const { dir } of work) {
        rolledBack = (await restoreStaging(dir)) && rolledBack
      }
    }

    logger.error('capture: cache conversion failed', { target: plan.target, detail, rolledBack })
    return { ok: false, detail, rolledBack }
  }
}

/**
 * 文件的字节数；读不到就按 0 算。
 *
 * 用在三个"数字只用于判断量级"的地方：切换的进度与确认框、以及落盘之后"这一份到底有多大"
 * （[ADR-0049] 的退化直通要按**实际大小**兜一次，因为分块传输没有 `content-length`）。
 */
export function fileBytes(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/**
 * 把暂存区里的条目搬回缓存目录（回滚）。
 *
 * 幂等，且**只做搬运**：搬不回去的留在暂存区，返回 `false`，由调用方告诉用户去核对。
 * 暂存区空了就把目录本身删掉（留着它会让下次启动多一次无意义的恢复）。
 */
export async function restoreStaging(dir: string = currentCacheMonthDir()): Promise<boolean> {
  const staging = stagingDir(dir)
  if (!existsSync(staging)) return true

  let complete = true

  for (const name of readdirSync(staging)) {
    try {
      await rename(join(staging, name), join(dir, name))
    } catch (error) {
      complete = false
      logger.error('capture: could not move a cache entry back', { reason: failureReason(error) })
    }
  }

  if (complete) {
    try {
      await rmdir(staging)
    } catch {
      // 删不掉一个空目录不影响任何东西：下次启动会再试一次。
    }
  }

  return complete
}

/**
 * 删掉暂存区里的内容，返回**没能删掉**的条目数。
 *
 * 这一步发生在提交之后，因此它**不允许**让切换回退（见 [ADR-0027] 的影响一节）：
 * 状态已经切过去了，剩下的只是磁盘空间。删不掉的会留到下次启动。
 */
export async function purgeStaging(dir: string = currentCacheMonthDir()): Promise<number> {
  const staging = stagingDir(dir)
  if (!existsSync(staging)) return 0

  let remaining = 0

  for (const name of readdirSync(staging)) {
    try {
      await rm(join(staging, name), { force: true })
    } catch (error) {
      remaining += 1
      logger.warn('capture: could not purge a staged cache file', {
        reason: failureReason(error),
      })
    }
  }

  if (remaining === 0) {
    try {
      await rmdir(staging)
    } catch {
      // 同上：空目录删不掉不影响任何东西。
    }
  }

  return remaining
}

/**
 * 启动时处理上次切换留下的暂存区。
 *
 * **判据是"已提交的设置"，不是"记得什么"。** 进程被 kill 时没有任何代码在跑，当场回退
 * 是不可能的；因此：
 *
 *   设置说"开启" ⇒ 那次切换没走到提交 ⇒ **搬回去**（回退）
 *   设置说"关闭" ⇒ 提交已经发生、只剩收尾 ⇒ **删掉**（完成）
 *
 * 返回搬回的条目数（仅用于日志）。这也是 `reconcileCiphertextCache()` 的第一步。
 */
export async function recoverStaging(
  enabled: boolean,
  dir: string = currentCacheMonthDir(),
): Promise<number> {
  const staging = stagingDir(dir)
  if (!existsSync(staging)) return 0

  if (enabled) {
    const restored = existsSync(staging) ? readdirSync(staging).length : 0
    const complete = await restoreStaging(dir)

    logger.warn('capture: an unfinished cache switch was rolled back', { restored, complete })
    return restored
  }

  const remaining = await purgeStaging(dir)
  logger.info('capture: an unfinished cache switch was completed', { remaining })
  return 0
}

// ---------------------------------------------------------------------------
// 启动对账（ADR-0026）
// ---------------------------------------------------------------------------

export interface CacheReconcileResult {
  /** 删掉的文件数。0 表示磁盘本来就与设置一致。 */
  readonly removed: number
  /** 删掉的字节数，用于回答"这一下省了多少磁盘"。 */
  readonly bytes: number
  /** 保留的条目文件数：开启时是可命中的条目数，关闭时正常为 0。 */
  readonly kept: number
  /**
   * 目录里**不是缓存条目**的东西（子目录、符号链接、别的文件）—— 一律不动。
   * 正常永远是 0；不为 0 说明这个目录里混进了不属于它的东西，值得看一眼。
   */
  readonly foreign: number
}

/**
 * 让磁盘上的缓存与**这次启动要用的状态**一致。
 *
 * 顺序：先处理上次切换留下的暂存区（{@link recoverStaging}），再按设置对账；遍历范围是
 * **所有账号目录 × 它们下面的月份目录**（[ADR-0039]）。
 *
 * - **关闭**：把我们写的条目全部删掉。用户关掉它的意思就是"不要在本机留这些密文"，留着
 *   既与设置不一致，也让 `docs/security.md` 那句"可被长期留存分析"继续成立。纯派生数据
 *   （[ADR-0008]），删了只影响速度。**不认识的扩展名不删** —— 那不出自本应用。
 * - **开启**：只删不可能命中的残留（见 {@link orphanEntries}）。**可命中的条目一律留着** ——
 *   这就是"兼容性"：把缓存重新打开，不该让用户把以前下载过的东西再下一次。
 *
 * 另有一件一次性的清理：**老的平铺布局**（条目直接躺在 `cache/` 根下）在 [ADR-0039] 之后
 * 再也命不中，因此整批删掉 —— 留着只是白占磁盘。
 *
 * 正常路径下这里已经没有事可做（切换在维护界面里就完成了，见 [ADR-0027]）：它现在是
 * **兜底** —— 上次进程被 kill、或设置被手工改过时，把磁盘拉回与设置一致的状态。
 * 判据是"目录内容 vs 当前设置"，因此它幂等、无状态，不需要多一份持久化的"上次是什么"。
 */
export async function reconcileCiphertextCache(enabled: boolean): Promise<CacheReconcileResult> {
  const root = ciphertextCacheDir()

  // 老布局（`<根>/<key>.bin`）先清：它们在新的查找路径上永远命不中。
  const legacy = purgeLegacyFlatEntries(root)

  let removed = legacy.removed
  let bytes = legacy.bytes
  let kept = 0
  let foreign = legacy.foreign

  for (const accountDir of cacheAccountDirs(root)) {
    for (const dir of cacheMonthDirs(accountDir)) {
      // 先处理上次切换留下的暂存区（它就在这个月份目录里），再按设置对账。
      await recoverStaging(enabled, dir)

      const result = reconcileEntryDir(dir, enabled)

      removed += result.removed
      bytes += result.bytes
      kept += result.kept
      foreign += result.foreign
    }

    // 账号目录那一层只允许出现月份目录（名称不合形状的目录由 `cacheAccountDirs` 挡在外面，
    // 这里数的是"账号目录里多出来的别的东西"）。
    foreign += countForeign(accountDir, isArchiveMonthDir)
  }

  if (removed > 0) {
    logger.info('capture: ciphertext cache reconciled', { enabled, removed, bytes, kept })
  } else {
    logger.debug('capture: ciphertext cache already consistent', { enabled, kept })
  }

  if (foreign > 0) {
    logger.warn('capture: foreign entries in the cache directory', { count: foreign })
  }

  return { removed, bytes, kept, foreign }
}

/** 单个月份目录的对账：算目标、删目标、统计。与旧实现同一条判据，只是按目录调用。 */
function reconcileEntryDir(dir: string, enabled: boolean): CacheReconcileResult {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    // 目录不存在（还没写过任何东西的月份）是正常情况，不是错误。
    if (existsSync(dir)) {
      logger.warn('capture: could not read a cache directory', { reason: failureReason(error) })
    }
    return { removed: 0, bytes: 0, kept: 0, foreign: 0 }
  }

  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  const ours = files.filter(isEntryName)

  // "混进来的东西" = 不是条目的文件 + 目录/符号链接；暂存区是我们自己的，不算。
  const foreign =
    entries.length - ours.length - Number(entries.some((e) => e.name === STAGING_DIR_NAME))
  const targets = enabled ? orphanEntries(ours) : ours

  let removed = 0
  let bytes = 0

  for (const name of targets) {
    const path = join(dir, name)
    try {
      const size = fileBytes(path)
      rmSync(path)
      bytes += size
      removed += 1
    } catch (error) {
      // 删不掉只记日志：缓存是派生数据，这一次失败不影响任何正确性，下次启动还会再试。
      logger.warn('capture: could not remove a cache file', { reason: failureReason(error) })
    }
  }

  return { removed, bytes, kept: ours.length - removed, foreign }
}

/**
 * 清掉 [ADR-0039] 之前的平铺布局：`<缓存根>/<key>.bin|.meta.json`。
 *
 * 它们现在既不会被查到、也不会被写，留着只是占磁盘 —— 而缓存是**纯派生数据**
 * （[ADR-0008]：随时可安全删除），因此这里删得干脆。不认识的扩展名仍然不算我们的东西。
 */
function purgeLegacyFlatEntries(root: string): CacheReconcileResult {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return { removed: 0, bytes: 0, kept: 0, foreign: 0 }
  }

  const accounts = new Set(
    entries
      .filter((entry) => entry.isDirectory() && isAccountSegment(entry.name, accountKey()))
      .map((entry) => entry.name),
  )

  let removed = 0
  let bytes = 0
  let foreign = 0

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // 认不出来的目录不是我们的；也不去数它里面的东西。
      if (!accounts.has(entry.name)) foreign += 1
      continue
    }

    if (!entry.isFile() || !isEntryName(entry.name)) {
      foreign += 1
      continue
    }

    const path = join(root, entry.name)
    try {
      const size = fileBytes(path)
      rmSync(path)
      bytes += size
      removed += 1
    } catch (error) {
      logger.warn('capture: could not remove a legacy cache file', {
        reason: failureReason(error),
      })
    }
  }

  if (removed > 0) {
    logger.info('capture: removed the legacy flat cache layout', { removed, bytes })
  }

  return { removed, bytes, kept: 0, foreign }
}

/** 一个目录里"不是我们的东西"的条目数（文件、目录、符号链接都算，判据由调用方给）。 */
function countForeign(dir: string, isOurs: (name: string) => boolean): number {
  try {
    return readdirSync(dir).filter((name) => !isOurs(name)).length
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// 容量上限与淘汰（ADR-0049）
// ---------------------------------------------------------------------------
//
// 与归档那一侧（`archive/blobs.ts` 的 `evictToFit()` = [ADR-0048]）**形状相同、判据不同**：
// 那边按索引里的 `opened_at` 排序、删一份内容的全部磁盘名；这边没有索引，按**正文的 mtime**
// 排序、删成对的条目。两处共享的是同一条纪律：**只删我们写的东西**，超限只降级、不报错。

/**
 * 一个**可命中的**条目：正文与元信息成对存在（[ADR-0049] 决定 2）。
 *
 * 缺一半的残留不是条目 —— 回放要同时读两份（`readCached()`），它永远命不中，因此不计入
 * 总量、也不在这个流程里删（那由启动对账、切换与读命中处的 `dropEntry()` 收拾）。
 */
export interface CacheEntry {
  /** 内容键的 sha256（文件名去掉后缀）。 */
  readonly id: string
  /** 条目所在的月份目录。 */
  readonly dir: string
  /** 两份文件加起来占的字节数。 */
  readonly bytes: number
  /** 最后使用时间（Unix 毫秒）：正文文件的 `mtime`（[ADR-0049] 决定 1）。 */
  readonly usedAt: number
}

/** `stat` 的容错包装：读不到返回 `null`（并发删除、权限异常都走这条路）。 */
async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/**
 * 缓存里的全部**成对条目**（跨账号目录 × 月份目录，[ADR-0039]）。
 *
 * 用异步 IO：这个函数同时喂给**写入路径上的淘汰**（不能让一次下载卡住主进程）与界面的
 * 统计，而它要 readdir + 每个条目 stat —— 条目可能上万。
 */
export async function listCacheEntries(root: string = ciphertextCacheDir()): Promise<CacheEntry[]> {
  const found: CacheEntry[] = []

  for (const accountDir of cacheAccountDirs(root)) {
    for (const dir of cacheMonthDirs(accountDir)) {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        // 读不到（刚被删掉、权限异常）就当这个月份目录里没有条目。
        continue
      }

      const present = new Set(names)

      for (const name of names) {
        if (!name.endsWith(BODY_SUFFIX)) continue

        const id = name.slice(0, -BODY_SUFFIX.length)
        if (!present.has(`${id}${META_SUFFIX}`)) continue // 缺一半：不是条目。

        const body = await statOrNull(join(dir, name))
        const meta = await statOrNull(join(dir, `${id}${META_SUFFIX}`))

        // 两边都必须是**普通文件**：名字长得像条目的目录 / 符号链接不是我们的条目 ——
        // 与对账那边同一条判据（它只处理 `entry.isFile()`）。
        if (body?.isFile() !== true || meta?.isFile() !== true) continue

        found.push({ id, dir, bytes: body.size + meta.size, usedAt: body.mtimeMs })
      }
    }
  }

  return found
}

/** 当前占用：只算成对条目（界面的"现在占了多少"与淘汰的判据都用它）。 */
export async function cacheUsage(
  root: string = ciphertextCacheDir(),
): Promise<{ bytes: number; entries: number }> {
  const entries = await listCacheEntries(root)
  return { bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), entries: entries.length }
}

/**
 * 哪些条目该被淘汰：**最久未用优先**，直到删掉它们之后总量不超过 `maxBytes`。
 *
 * 纯函数（输入就是 {@link listCacheEntries} 的结果），因此淘汰顺序能脱离文件系统直接断言。
 * 一行都不多删：够到上限就停 —— 淘汰掉的每一份都要重新联网下载一次。
 */
export function selectCacheEvictions(
  entries: readonly CacheEntry[],
  totalBytes: number,
  maxBytes: number,
): CacheEntry[] {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || totalBytes <= maxBytes) return []

  const ordered = [...entries].sort((left, right) => left.usedAt - right.usedAt)
  const evicted: CacheEntry[] = []
  let remaining = totalBytes

  for (const entry of ordered) {
    if (remaining <= maxBytes) break

    evicted.push(entry)
    remaining -= entry.bytes
  }

  return evicted
}

export interface CacheEvictionResult {
  /** 真正删掉的条目数（两份文件都删成功才算一个；一个文件都没删掉的不计）。 */
  readonly entries: number
  readonly bytes: number
}

/**
 * 按 LRU 淘汰到占用不超过 `maxBytes`。
 *
 * 逐条 `await`：条目可能上万，用同步 API 会把主进程连同界面一起卡住（与 `convertCache()`
 * 同一条理由）。单个文件删不掉只记日志、继续处理后面的条目 —— 淘汰是维护动作，
 * 不该让它打断一次下载（下一次扫描还会看到它）。
 */
export async function evictCacheToFit(
  maxBytes: number,
  root: string = ciphertextCacheDir(),
): Promise<CacheEvictionResult> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { entries: 0, bytes: 0 }

  const entries = await listCacheEntries(root)
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  const targets = selectCacheEvictions(entries, total, maxBytes)

  let evicted = 0
  let bytes = 0

  for (const entry of targets) {
    const paths = cacheEntryPaths(entry.dir, entry.id)
    let freed = 0
    let files = 0

    for (const path of [paths.body, paths.meta]) {
      try {
        const size = (await statOrNull(path))?.size ?? 0
        await rm(path, { force: true })
        freed += size
        files += 1
      } catch (error) {
        logger.warn('capture: could not evict a cache file', { reason: failureReason(error) })
      }
    }

    if (files > 0) {
      evicted += 1
      bytes += freed
    }
  }

  return { entries: evicted, bytes }
}

/**
 * 让缓存占用不超过 `maxBytes`，**永不抛错**（[ADR-0049]）。
 *
 * 与归档那一侧的 `enforceArchiveLimit()`（[ADR-0048]）同一条纪律：淘汰是维护动作，
 * 它失败了也不该让一次下载或一次设置改动失败。三个触发点（写入后、启动对账后、
 * 改上限设置时）都用它，因此把"永不抛错"收在这里。
 *
 * @returns 删掉的条目数（便于日志确认）。
 */
export async function enforceCacheLimit(maxBytes: number): Promise<number> {
  try {
    const result = await evictCacheToFit(maxBytes)

    if (result.entries > 0) {
      logger.info('capture: cache limit enforced', { entries: result.entries, bytes: result.bytes })
    }

    return result.entries
  } catch (error) {
    logger.warn('capture: failed to enforce the cache limit', { reason: failureReason(error) })
    return 0
  }
}

/**
 * 命中留痕：把正文的 `mtime` 推到"现在"（[ADR-0049] 决定 1）。
 *
 * 刻意**不节流**：一次命中最少也要读几 KB，而更新 mtime 只是一次 syscall —— 成本被它盖过。
 * 失败只记 `debug`：缓存是派生数据，留痕失败最坏也只是这一条被当成"更久没用"先淘汰。
 */
export function touchCacheEntry(bodyPath: string): void {
  try {
    const now = new Date()
    utimesSync(bodyPath, now, now)
  } catch (error) {
    logger.debug('capture: could not update a cache entry timestamp', {
      reason: failureReason(error),
    })
  }
}

/** 两次全盘扫描之间允许写入的字节量下限 / 上限（[ADR-0049] 决定 3）。 */
const MIN_SWEEP_BYTES = 8 * 1024 * 1024
const MAX_SWEEP_BYTES = 64 * 1024 * 1024

/**
 * 两次全盘扫描之间允许写入多少字节（[ADR-0049] 决定 3）。
 *
 * `上限 / 16`，钳在 8–64 MiB 之间，且**不超过上限本身**（否则"上限 1 MiB"的用户会先写进
 * 8 MiB 才触发第一次淘汰）。`0` 表示不限制 ⇒ 也返回 `0`（调用方按"永不扫描"处理）。
 */
export function cacheSweepInterval(maxBytes: number): number {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return 0

  return Math.min(Math.max(Math.floor(maxBytes / 16), MIN_SWEEP_BYTES), MAX_SWEEP_BYTES, maxBytes)
}

/**
 * 这份内容该不该落盘（[ADR-0049] 决定 4）：**本身就超过上限的不缓存**。
 *
 * 理由不是省空间，而是**顺序**：淘汰按 LRU 排序，最新写下的那份永远排在最后 —— 一旦只剩
 * 它一个，就轮不到别人被删，它会先把整个缓存清空、再删掉自己。靠调淘汰顺序解决不了。
 *
 * `bytes` 为 0（不知道长度，例如分块传输）或上限为 0（不限制）时一律返回 `true`；
 * 前者由 `persist()` 在写完之后按**实际大小**再兜一次。
 */
export function shouldCacheEntry(bytes: number, maxBytes: number): boolean {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return true
  if (!Number.isFinite(bytes) || bytes <= 0) return true

  return bytes <= maxBytes
}
