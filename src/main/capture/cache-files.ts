/**
 * 密文缓存的**磁盘侧**：条目形态、残留判定、与设置对账。
 *
 * 为什么不写在 `capture/protocol.ts` 里：那里 import electron（`net` / `Session`），而
 *
 *   - 对账发生在会话建立**之前**，与"拦截请求"是两件事；
 *   - 单测与离线自检都进不去带 electron 的模块（ai/CONVENTIONS.md 第 8 节）。
 *
 * 因此把"条目长什么样、目录该怎么收拾"放在这里，协议层只留拦截。
 *
 * 缓存是纯派生数据：[ADR-0008] 把它列为"可随时安全删除" —— 本模块的对账就是这句话的
 * 落点。它处理的始终是**密文的字节**，不是它的含义，因此这里不该出现任何密钥、
 * 派生或加解密代码（[INV-3]）。
 */

import { readdirSync, rmSync, statSync, type Dirent } from 'node:fs'
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

/** 一个条目的两个文件。 */
export function cacheEntryPaths(dir: string, id: string): { body: string; meta: string } {
  return { body: join(dir, `${id}${BODY_SUFFIX}`), meta: join(dir, `${id}${META_SUFFIX}`) }
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
 * 让磁盘上的缓存与**这次启动要用的状态**一致（[ADR-0026]）。
 *
 * 调用时机是会话建立之前（见 `session.ts`）：那一刻没有任何请求在飞，因此不存在
 * "把正在写的条目当成残留删掉"的可能 —— 而 `persist()` 是先写正文、后写元信息的，
 * 两者之间进程被杀留下的恰好是"缺一半"。
 *
 * - **关闭**：把我们写的条目全部删掉。用户关掉它的意思就是"不要在本机留这些密文"，留着
 *   既与设置不一致，也让 `docs/security.md` 那句"可被长期留存分析"继续成立。纯派生数据
 *   （[ADR-0008]），删了只影响速度。**不认识的扩展名不删** —— 那不出自本应用。
 * - **开启**：只删不可能命中的残留（见 {@link orphanEntries}）。**可命中的条目一律留着** ——
 *   这就是"兼容性"：把缓存重新打开，不该让用户把以前下载过的东西再下一次。
 *
 * 判据是"目录内容 vs 当前设置"，不是"上次是什么"：因此它幂等、无状态，每次启动都跑一遍
 * （关闭时空目录的代价只有一次 `readdir`），不需要多一份可能与现实不符的持久状态。
 */
export function reconcileCiphertextCache(enabled: boolean): CacheReconcileResult {
  const dir = ciphertextCacheDir()

  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // 目录不存在（还没开过缓存的新机器）是正常情况，不是错误：不建它。
    return { removed: 0, bytes: 0, kept: 0, foreign: 0 }
  }

  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  const ours = files.filter(isEntryName)
  const foreign = entries.length - ours.length

  // 关闭：**我们写的条目**全删（不认识的扩展名不是我们的，留着）。
  // 开启：只删不可能命中的残留。
  const targets = enabled ? orphanEntries(ours) : ours

  let removed = 0
  let bytes = 0

  for (const name of targets) {
    const path = join(dir, name)
    try {
      const size = statSync(path).size
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
