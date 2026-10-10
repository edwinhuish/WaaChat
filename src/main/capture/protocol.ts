/**
 * 接管点 B：密文磁盘缓存。
 *
 * 解决的问题很具体：上游每次点击同一个文件都会重新从 CDN 拉一遍。缓存之后，
 * 二次打开是本地读取。
 *
 * 三个必须理解的设计点：
 *
 *  1. **缓存的是密文，不是明文。** 因此完全不碰加密（INV-3）。页面拿到密文后
 *     自己解密，我们只是替它把网络请求省掉。这也意味着这个模块里不该出现任何
 *     密钥、派生、加解密代码。
 *
 *  2. **只接管媒体 CDN，其余流量原样放行。** 会话级 `protocol.handle('https')`
 *     会接住该分区的**所有** https 请求，因此直通路径必须是最保守的一条。
 *
 *  3. **幂等键由 cachekey.ts 推导**，那里有它自己的坑（宁可漏命中，不可错命中）。
 *
 *  4. **PDF 的一处改写挂在这里**（[ADR-0029]，与缓存无关）：协议处理器返回的响应就是
 *     最终响应，`webRequest` 改不动它（实测），因此"缓存开着时不让内核内嵌渲染 PDF"
 *     只有这一个地方能做 —— 见下面的 {@link passthrough}。
 *
 *  5. **直通请求发回它自己的会话，并且在抖动时重试**（[ADR-0033]）：这一层接住的是**分区**里的
 *     请求，因此必须用 `ses.fetch` 而不是默认会话的 `net.fetch` —— cookie 罐子、代理与证书
 *     配置、连接池都挂在会话上，重发到别的会话等于把同一份流量拆成两套（实测：响应里的
 *     `Set-Cookie` 会进错罐子）。连接层失败交给 `retry.ts` 的有限重试。
 */

import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { Session } from 'electron'

import {
  CACHE_DIR_MODE,
  CACHE_VERSION,
  cacheEntryPaths,
  currentCacheMonthDir,
  findCacheEntry,
} from './cache-files'
import { deriveCacheKey } from './cachekey'
import { carriedHeaders } from './headers'
import { forceDownloadIfPdf } from './pdf'
import { setCiphertextCacheActive } from './health'
import { fetchWithRetry, type RetryAttempt } from './retry'
import { failureReason } from '../errors'
import { hostOf, logger } from '../logger'
import { ciphertextAccountDir } from '../paths'

/** 这一层现在挂着没有。注册是一次性的，因此必须自己记着（见 attach/detach）。 */
let attached = false

interface CachedMeta {
  readonly version: number
  readonly url: string
  readonly headers: Record<string, string>
  readonly bytes: number
  readonly storedAt: number
}

export function attachCiphertextCache(ses: Session): void {
  /**
   * 一次会话里同一个 scheme 只能注册一次（重复注册会抛错）。切换流程会在两个方向上来回
   * 切，因此记得住"现在挂着没有"比事后去猜要可靠 —— 也让这个调用是幂等的。
   */
  if (attached) return

  // 条目落在 `<账号>/<年-月>/`（[ADR-0039]）：这里只保证账号那一层存在，
  // 月份目录在**写入时**按需创建（读取时可能一个都没有 —— 那就是没缓存过）。
  const dir = ciphertextAccountDir()
  mkdirSync(dir, { recursive: true, mode: CACHE_DIR_MODE })

  ses.protocol.handle('https', async (request) => {
    const key = deriveCacheKey(request.url)
    if (key === null) return passthrough(request, ses)

    /**
     * 分片请求不参与缓存。
     *
     * 上游对视频等大文件会发 Range 请求，而那意味着我们要正确处理 206、
     * Content-Range 与部分内容拼接 —— 复杂度与出错面都远高于收益。
     * 放行它们只是"视频仍然联网播放"，而错误地回应一个 Range 请求会让播放直接坏掉。
     */
    if (request.method !== 'GET' || request.headers.has('range')) {
      return passthrough(request, ses)
    }

    const id = createHash('sha256').update(key).digest('hex')

    // 跨月份找：同一条密文可能是在上个月写下的（条目按写入时的月份落盘）。
    const entry = findCacheEntry(id)
    if (entry !== null) {
      const cached = readCached(entry.body, entry.meta)
      if (cached !== null) {
        logger.debug('capture: ciphertext cache hit')
        // 这一层返回给页面的响应都要过一遍 PDF 规则：缓存键只认得媒体 CDN（密文），
        // 理论上不会出现 PDF 条目 —— 但"理论上"不该是安全性的依据（[ADR-0029]）。
        return forceDownloadIfPdf(cached)
      }
    }

    const response = await passthrough(request, ses)

    // 只缓存成功的、完整的响应。失败与 3xx 落盘没有意义，还会污染缓存。
    if (response.ok) {
      const monthDir = currentCacheMonthDir()
      mkdirSync(monthDir, { recursive: true, mode: CACHE_DIR_MODE })

      const { body: bodyPath, meta: metaPath } = cacheEntryPaths(monthDir, id)
      persist(bodyPath, metaPath, request.url, response)
    }

    return response
  })

  attached = true
  setCiphertextCacheActive(true)
  logger.info('capture: ciphertext layer attached', { dir })

  // TODO(M3)：容量上限与淘汰。当前实现只增不减，达到上限时会无声地吃掉磁盘。
  // 实现要点见 docs/media-capture.md 第 3 节：超限先淘汰，仍不够则退化为直通，
  // 而不是让请求失败。
}

/**
 * 摘掉这一层（[ADR-0027] 的事务式切换要用）。
 *
 * 摘掉之后**任何流量都不再经过我们**：实测 `unhandle` 之后请求直接回到 Chromium 的网络栈
 * （探针见 ADR-0027 理由 1）。这正是要的效果 —— "关闭"应当意味着与原生内核无差别，而不是
 * 留下一段什么都不做的直通代码在路径上。
 *
 * 幂等；对已经摘掉的会话调用只是把状态标签置回关闭。
 */
export function detachCiphertextCache(ses: Session): void {
  if (attached) {
    try {
      ses.protocol.unhandle('https')
    } catch (error) {
      // 摘不掉也不能把流程卡住：状态标签置回关闭，行为上等同于直通（下一次启动会重来）。
      logger.warn('capture: could not unhandle the ciphertext layer', {
        reason: failureReason(error),
      })
    }

    attached = false
  }

  setCiphertextCacheActive(false)
  logger.info('capture: ciphertext layer detached')
}

/** 这一层现在挂着没有。切换流程按它决定回滚时该恢复成哪一边。 */
export function isCiphertextCacheAttached(): boolean {
  return attached
}

/**
 * 原样回源，出口处过一遍 PDF 规则（[ADR-0029]）—— 请求一个字节没动，只有"这份响应能不能
 * 被内核内嵌显示"被降级成下载。
 *
 * **为什么必须用 `ses.fetch` 而不是 `net.fetch`**（[ADR-0033]）：我们接住的是这个**分区**里的
 * 请求，而 `net.fetch` 发在默认会话上 —— cookie 罐子、代理与证书配置、连接池都不是同一个。
 * 实测过两条后果：响应里的 `Set-Cookie` 会进默认会话的罐子（页面自己的罐子永远得不到更新），
 * 以及两套连接池各开一条连接。
 *
 * `bypassCustomProtocolHandlers` 是必需的：不带它，这次 fetch 会再次进入我们自己的处理器，
 * 形成无限递归（表现为请求挂死）。
 *
 * 连接层失败按 [ADR-0033] 做有限重试：网络抖动时一次握手被重置本可以靠重试救回来，而
 * Chromium 不替调用方重试。重试与放弃各记一条日志，**只带 host 与错误码**（G-1 / G-3）——
 * Chromium 自己那行 `handshake failed` 不带主机名，用户拿到的信息只够猜。
 */
async function passthrough(request: Request, ses: Session): Promise<Response> {
  const logContext = (info: RetryAttempt): Record<string, unknown> => ({
    host: hostOf(request.url),
    attempt: info.attempt,
    limit: info.limit,
    error: info.error,
  })

  const response = await fetchWithRetry(
    (current) => ses.fetch(current, { bypassCustomProtocolHandlers: true }),
    request,
    {
      onRetry: (info) => {
        logger.warn('capture: retrying after a connection failure', logContext(info))
      },
      onGaveUp: (info) => {
        logger.warn('capture: gave up on a flaky connection', logContext(info))
      },
    },
  )

  return forceDownloadIfPdf(response)
}

function readCached(bodyPath: string, metaPath: string): Response | null {
  if (!existsSync(bodyPath) || !existsSync(metaPath)) {
    // 缺一半的条目永远命不中（回放要同时读正文与元信息）—— 顺手清掉，不让它白占磁盘。
    dropEntry(bodyPath, metaPath)
    return null
  }

  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as CachedMeta

    /**
     * 旧格式不回放：它的响应头语义（[ADR-0016]）或**磁盘布局**（[ADR-0039] 把条目挪进了
     * 月份目录）可能已经不成立。
     *
     * ⚠️ 与布局改动之前不同：那时"同一个 URL 再请求一次"会原地覆盖掉旧条目，因此不必删。
     * 现在写入落在**当月**目录里，旧条目再也不会被写到，所以必须在这里清掉。
     */
    if (meta.version !== CACHE_VERSION) {
      logger.debug('capture: cache entry has an older format, refetching')
      dropEntry(bodyPath, metaPath)
      return null
    }

    const stream = Readable.toWeb(createReadStream(bodyPath)) as ReadableStream<Uint8Array>

    return new Response(stream, { status: 200, headers: meta.headers })
  } catch (error) {
    // 元信息损坏时不要报错给页面 —— 删掉缓存项，让它去回源。
    logger.warn('capture: cache entry unreadable, will refetch', {
      reason: (error as Error).name,
    })
    dropEntry(bodyPath, metaPath)
    return null
  }
}

/**
 * 丢一个用不了的条目（缺一半、旧格式、读不出来）。**只删我们写的这两个文件**，
 * 且失败一律忽略 —— 缓存是派生数据（[ADR-0008]），下一次请求会重新写一份。
 */
function dropEntry(bodyPath: string, metaPath: string): void {
  for (const path of [bodyPath, metaPath]) {
    try {
      rmSync(path, { force: true })
    } catch {
      // 删不掉不影响任何正确性（下次对账/覆盖还会再试）。
    }
  }
}

/**
 * 落盘。
 *
 * 刻意**不** await：页面不该为了让缓存写盘而变慢。写失败只记日志 ——
 * 缓存是纯派生数据，它的失败绝不允许影响功能正确性。
 */
function persist(bodyPath: string, metaPath: string, url: string, response: Response): void {
  const headers = carriedHeaders(response.headers)

  /**
   * 必须 clone。
   *
   * 响应体是一条只能读一次的流，而它同时要交给页面（我们返回给调用方）和写盘。
   * `clone()` 会把它 tee 成两条，因此落盘不会把页面那一路吃掉 ——
   * 漏掉这一行的话，页面拿到的是一个已经读空的响应，症状是"缓存开启后所有文件都打不开"。
   */
  const copy = response.clone()
  const body = copy.body
  if (body === null) return

  const declared = Number(headers['content-length'] ?? 0)
  const meta: CachedMeta = {
    version: CACHE_VERSION,
    url,
    headers,
    bytes: Number.isFinite(declared) ? declared : 0,
    storedAt: Date.now(),
  }

  void pipeline(Readable.fromWeb(body as never), createWriteStream(bodyPath))
    .then(() => {
      // 元信息写在正文之后：若元信息先落地而正文写了一半，缓存会稳定命中到坏数据，
      // 表现为"这个文件永远打不开"——比不缓存严重得多。
      writeFileSync(metaPath, `${JSON.stringify(meta)}\n`, 'utf8')
      logger.debug('capture: ciphertext cached')
    })
    .catch((error: unknown) => {
      logger.warn('capture: failed to persist ciphertext', {
        reason: (error as Error).name,
      })
    })
}
