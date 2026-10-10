/**
 * 接管点 B：密文磁盘缓存。
 *
 * 解决的问题很具体：上游每次点击同一个文件都会重新从 CDN 拉一遍。缓存之后，
 * 二次打开是本地读取。
 *
 * 五个必须理解的设计点：
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
 *  4. **直通请求发回它自己的会话，并且在抖动时重试**（[ADR-0033]）：这一层接住的是**分区**里的
 *     请求，因此必须用 `ses.fetch` 而不是默认会话的 `net.fetch` —— cookie 罐子、代理与证书
 *     配置、连接池都挂在会话上，重发到别的会话等于把同一份流量拆成两套（实测：响应里的
 *     `Set-Cookie` 会进错罐子）。连接层失败交给 `retry.ts` 的有限重试。
 *
 *  5. **容量上限在这里收口**（[ADR-0049]）：命中时更新正文的 `mtime`（"最久未用优先淘汰"
 *     唯一的输入）、落盘完成后按**字节节流**地淘汰一次、**一份本身就超上限的内容不落盘**。
 *     超限只降级（少一份缓存）、不报错，也绝不把请求卡住。
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

import type { Settings } from '../../shared/types'
import {
  CACHE_DIR_MODE,
  CACHE_VERSION,
  cacheEntryPaths,
  cacheSweepInterval,
  currentCacheMonthDir,
  enforceCacheLimit,
  fileBytes,
  findCacheEntry,
  shouldCacheEntry,
  touchCacheEntry,
} from './cache-files'
import { deriveCacheKey } from './cachekey'
import { carriedHeaders } from './headers'
import {
  applyRequestContext,
  clearRequestContexts,
  rememberRequestContext,
} from './request-context'
import {
  describeNetworkError,
  fetchWithRetry,
  isTransientNetworkError,
  type RetryAttempt,
} from './retry'
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

export function attachCiphertextCache(ses: Session, getSettings: () => Settings): void {
  /**
   * 一次会话里同一个 scheme 只能注册一次（重复注册会抛错）。切换流程会在两个方向上来回
   * 切，因此记得住"现在挂着没有"比事后去猜要可靠 —— 也让这个调用是幂等的。
   */
  if (attached) return

  // 条目落在 `<账号>/<年-月>/`（[ADR-0039]）：这里只保证账号那一层存在，
  // 月份目录在**写入时**按需创建（读取时可能一个都没有 —— 那就是没缓存过）。
  const dir = ciphertextAccountDir()
  mkdirSync(dir, { recursive: true, mode: CACHE_DIR_MODE })

  /**
   * 记下每个请求的**角色**（[ADR-0058]）。
   *
   * `protocol.handle` 拿到的 `Request` 上已经没有 fetch 元数据了（`Sec-Fetch-*` / `Referer`
   * 都不在 `request.headers` 里），而直通只能用 `ses.fetch` 重发 —— 重发出去的那一份会被
   * 内核当成"主进程发起的无上下文请求"。要还原，只能在这里（请求还没进处理器之前）先把
   * 角色抄下来。**只读**：`callback({})` 放行，不改一个字节。
   *
   * 生命周期与密文层相同：摘掉时要一起撤销（见 detach）。
   */
  ses.webRequest.onBeforeRequest((details, callback) => {
    rememberRequestContext(details)
    callback({})
  })

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
        /**
         * 命中留痕：这是"最久未用优先淘汰"唯一的输入（[ADR-0049]）。放在**返回响应之前**，
         * 因此"这一次命中"一定会被算进 LRU 顺序里。
         */
        touchCacheEntry(entry.body)
        logger.debug('capture: ciphertext cache hit')
        return cached
      }
    }

    const response = await passthrough(request, ses)

    // 只缓存成功的、完整的响应。失败与 3xx 落盘没有意义，还会污染缓存。
    if (response.ok) {
      const monthDir = currentCacheMonthDir()
      mkdirSync(monthDir, { recursive: true, mode: CACHE_DIR_MODE })

      const { body: bodyPath, meta: metaPath } = cacheEntryPaths(monthDir, id)
      persist(bodyPath, metaPath, request.url, response, getSettings)
    }

    return response
  })

  attached = true
  logger.info('capture: ciphertext layer attached', { dir })
}

/**
 * 摘掉这一层（[ADR-0027] 的事务式切换要用）。
 *
 * 摘掉之后**任何流量都不再经过我们**：实测 `unhandle` 之后请求直接回到 Chromium 的网络栈
 * （探针见 ADR-0027 理由 1）。这正是要的效果 —— "关闭"应当意味着与原生内核无差别，而不是
 * 留下一段什么都不做的直通代码在路径上。
 *
 * 幂等；对已经摘掉的会话调用只是把进程内的状态置回关闭。
 */
export function detachCiphertextCache(ses: Session): void {
  if (attached) {
    try {
      ses.protocol.unhandle('https')
    } catch (error) {
      // 摘不掉也不能把流程卡住：状态置回关闭，行为上等同于直通（下一次启动会重来）。
      logger.warn('capture: could not unhandle the ciphertext layer', {
        reason: failureReason(error),
      })
    }

    // 观察者与队列同生命周期（[ADR-0058]）：层摘掉之后不再有请求经我们重发，
    // 留着它只会积累用不到的角色。
    ses.webRequest.onBeforeRequest(null)
    clearRequestContexts()

    attached = false
  }

  logger.info('capture: ciphertext layer detached')
}

/** 这一层现在挂着没有。切换流程按它决定回滚时该恢复成哪一边。 */
export function isCiphertextCacheAttached(): boolean {
  return attached
}

/**
 * 原样回源：请求一个字节没动，响应也一个字节没动。
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
 *
 * 重发**必须**先把原请求的 fetch 元数据补回去（[ADR-0058]，判据在 `request-context.ts`）：
 * `ses.fetch` 发出去的那一份会被内核当成"主进程发起的无上下文请求"（`Sec-Fetch-Site: none`
 * / `Mode: no-cors` / `Dest: empty`，且 `Referer` 丢失），而**上游按这些头回不同的变体** ——
 * 文档预览页因此只拿到 Meta 的通用外壳（实测 183 KB，没有 viewer 的引导脚本），
 * 表现是预览面板一直转圈。
 */
async function passthrough(request: Request, ses: Session): Promise<Response> {
  applyRequestContext(request)

  const logContext = (info: RetryAttempt): Record<string, unknown> => ({
    host: hostOf(request.url),
    attempt: info.attempt,
    limit: info.limit,
    error: info.error,
  })

  try {
    return await fetchWithRetry(
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
  } catch (error) {
    logPassthroughFailure(request, error)
    throw error
  }
}

/**
 * 重发失败时的最后一道可见性。
 *
 * **不值得重试**的错误（`fetchWithRetry` 原样抛出的那些）此前会**直接抛给内核** ——
 * 只在终端留一行裸 stderr，日志文件里什么都没有：用户看得见噪音、我们拿不到 host。
 * 实测踩过：`Sec-Fetch-Mode: cors` 会让每一份重发都以 `net::ERR_INVALID_ARGUMENT` 失败，
 * 而这条路径当时没有任何日志，排查只能靠猜。
 *
 * 仍然只记 `host` 与**错误码**（G-1 / G-3，非网络错误只给错误名）。`net::ERR_ABORTED`
 * 是页面正常的取消（切会话、翻页都会发生），不记 —— 否则日志会被它淹掉。
 */
function logPassthroughFailure(request: Request, error: unknown): void {
  if (isTransientNetworkError(error)) return

  const code = describeNetworkError(error)
  if (code === 'net::ERR_ABORTED') return

  logger.warn('capture: passthrough failed', { host: hostOf(request.url), error: code })
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
 *
 * [ADR-0049] 的两条容量规则都挂在这里：**单份超上限就不落盘**（前后各判一次），
 * 以及**写完之后按字节节流地**淘汰一次。
 */
function persist(
  bodyPath: string,
  metaPath: string,
  url: string,
  response: Response,
  getSettings: () => Settings,
): void {
  const headers = carriedHeaders(response.headers)

  /**
   * 先按 `content-length` 判一次（[ADR-0049] 决定 4）。**必须**在写之前判：淘汰按 LRU
   * 排序，最新写下的那份排在最后 —— 一旦只剩它一个，它会先把整个缓存清空、再删掉自己。
   * 提前不写就没有这个问题；缺 `content-length` 时这次判断落空，写完再按实际大小兜一次。
   */
  if (!shouldCacheEntry(Number(headers['content-length'] ?? 0), getSettings().cacheMaxBytes)) {
    logger.debug('capture: entry exceeds the cache limit, not caching')
    return
  }

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
    .then(async () => {
      const size = fileBytes(bodyPath)

      // 写完之后的第二次判断：`content-length` 缺失（分块传输）或不可信时，以磁盘上的
      // 实际大小为准。**必须删掉**刚写下的这一份，否则下一次淘汰会为了它清空整个缓存。
      if (!shouldCacheEntry(size, getSettings().cacheMaxBytes)) {
        dropEntry(bodyPath, metaPath)
        logger.debug('capture: entry exceeds the cache limit, dropped')
        return
      }

      // 元信息写在正文之后：若元信息先落地而正文写了一半，缓存会稳定命中到坏数据，
      // 表现为"这个文件永远打不开"——比不缓存严重得多。
      writeFileSync(metaPath, `${JSON.stringify(meta)}\n`, 'utf8')
      logger.debug('capture: ciphertext cached')

      await maybeEnforceLimit(size, getSettings().cacheMaxBytes)
    })
    .catch((error: unknown) => {
      logger.warn('capture: failed to persist ciphertext', {
        reason: (error as Error).name,
      })
    })
}

/**
 * 自上次全盘扫描以来，写入路径落盘了多少字节（[ADR-0049] 决定 3）。
 *
 * 进程内的状态就够了：它的作用只是"别每写一个文件就扫一遍全盘"，重启后归零没有任何后果
 * —— 启动对账之后本来就会扫一次。
 */
let pendingBytes = 0

/**
 * 写入之后**可能**淘汰一次。
 *
 * 节流是必需的：算总量要 readdir + 每个条目 stat 一次，而缓存按设计可以有几万条 ——
 * 每个请求都扫一遍等于主进程在一次下载里被反复打断（[ADR-0049] 理由 2）。
 */
async function maybeEnforceLimit(writtenBytes: number, maxBytes: number): Promise<void> {
  const interval = cacheSweepInterval(maxBytes)
  if (interval === 0) return // 不限制

  pendingBytes += writtenBytes
  if (pendingBytes < interval) return

  // 先清账再扫：扫描期间发生的写入属于**下一轮**，不该被这一次吞掉。
  pendingBytes = 0
  await enforceCacheLimit(maxBytes)
}
