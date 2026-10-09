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

import { existsSync, readdirSync, rmSync, statSync, type Dirent } from 'node:fs'
import { mkdir, rename, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'

import { failureReason } from '../errors'
import { logger } from '../logger'
import { ciphertextCacheDir } from '../paths'

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
 * ⚠️ `capture/headers.ts` 的白名单一变，这里**必须**加一（`ai/TASKS.md`）。
 */
export const CACHE_VERSION = 2

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

/** 缓存目录里的暂存区。 */
export function stagingDir(dir: string = ciphertextCacheDir()): string {
  return join(dir, STAGING_DIR_NAME)
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
 * 算一次切换要处理多少东西。
 *
 * 必须在**动手之前**算出来：确认框要写清楚"将清掉 N 个文件（X）"，而不是先让用户确认、
 * 再告诉他规模。读不到目录时 `ok: false` —— 此时不该开始切换。
 */
export function planCacheConversion(target: boolean): CacheConversionPlanResult {
  const dir = ciphertextCacheDir()
  const listed = targetEntries(dir, target)
  if (!listed.ok) return { ok: false, detail: listed.detail }

  return {
    ok: true,
    plan: { target, entries: listed.files.length, bytes: totalBytes(dir, listed.files) },
  }
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
  const dir = ciphertextCacheDir()
  const listed = targetEntries(dir, plan.target)
  if (!listed.ok) return { ok: false, detail: listed.detail, rolledBack: true }

  const names = listed.files
  let done = 0
  let bytesDone = 0

  try {
    if (!plan.target) {
      await mkdir(stagingDir(dir), { recursive: true, mode: CACHE_DIR_MODE })
    }

    for (const [index, name] of names.entries()) {
      const path = join(dir, name)
      const size = safeSize(path)

      if (plan.target) {
        await rm(path)
      } else {
        await rename(path, join(stagingDir(dir), name))
      }

      done += 1
      bytesDone += size
      hooks?.afterEntry?.(name, index)
    }

    return { ok: true, converted: done, bytes: bytesDone }
  } catch (error) {
    const detail = failureReason(error)

    // 关闭方向的失败必须把已经搬走的东西搬回来 —— 否则设置说"还开着"，缓存却少了一批。
    const rolledBack = plan.target ? true : await restoreStaging(dir)

    logger.error('capture: cache conversion failed', { target: plan.target, detail, rolledBack })
    return { ok: false, detail, rolledBack }
  }
}

/** 文件的字节数；读不到就按 0 算（它只用于进度与确认框的量级）。 */
function safeSize(path: string): number {
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
export async function restoreStaging(dir: string = ciphertextCacheDir()): Promise<boolean> {
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
export async function purgeStaging(dir: string = ciphertextCacheDir()): Promise<number> {
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
  dir: string = ciphertextCacheDir(),
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
 * 顺序：先处理上次切换留下的暂存区（{@link recoverStaging}），再按设置对账。
 *
 * - **关闭**：把我们写的条目全部删掉。用户关掉它的意思就是"不要在本机留这些密文"，留着
 *   既与设置不一致，也让 `docs/security.md` 那句"可被长期留存分析"继续成立。纯派生数据
 *   （[ADR-0008]），删了只影响速度。**不认识的扩展名不删** —— 那不出自本应用。
 * - **开启**：只删不可能命中的残留（见 {@link orphanEntries}）。**可命中的条目一律留着** ——
 *   这就是"兼容性"：把缓存重新打开，不该让用户把以前下载过的东西再下一次。
 *
 * 正常路径下这里已经没有事可做（切换在维护界面里就完成了，见 [ADR-0027]）：它现在是
 * **兜底** —— 上次进程被 kill、或设置被手工改过时，把磁盘拉回与设置一致的状态。
 * 判据是"目录内容 vs 当前设置"，因此它幂等、无状态，不需要多一份持久化的"上次是什么"。
 */
export async function reconcileCiphertextCache(enabled: boolean): Promise<CacheReconcileResult> {
  const dir = ciphertextCacheDir()
  await recoverStaging(enabled, dir)

  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    // 目录不存在（还没开过缓存的新机器）是正常情况，不是错误：不建它。
    if (existsSync(dir)) {
      logger.warn('capture: could not read the cache directory', { reason: failureReason(error) })
    }
    return { removed: 0, bytes: 0, kept: 0, foreign: 0 }
  }

  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  const ours = files.filter(isEntryName)

  // "混进来的东西" = 不是条目的文件 + 目录/符号链接；暂存区是我们自己的，不算。
  const foreign =
    entries.length - ours.length - entries.filter((entry) => entry.name === STAGING_DIR_NAME).length

  // 关闭：**我们写的条目**全删（不认识的扩展名不是我们的，留着）。
  // 开启：只删不可能命中的残留。
  const targets = enabled ? orphanEntries(ours) : ours

  let removed = 0
  let bytes = 0

  for (const name of targets) {
    const path = join(dir, name)
    try {
      const size = safeSize(path)
      rmSync(path)
      bytes += size
      removed += 1
    } catch (error) {
      // 删不掉只记日志：缓存是派生数据，这一次失败不影响任何正确性，下次启动还会再试。
      logger.warn('capture: could not remove a cache file', { reason: failureReason(error) })
    }
  }

  const kept = ours.length - removed

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
