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
 */

import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { net, type Session } from 'electron'

import { CACHE_DIR_MODE, CACHE_VERSION, cacheEntryPaths } from './cache-files'
import { deriveCacheKey } from './cachekey'
import { carriedHeaders } from './headers'
import { setCiphertextCacheActive } from './health'
import { logger } from '../logger'
import { ciphertextCacheDir } from '../paths'

interface CachedMeta {
  readonly version: number
  readonly url: string
  readonly headers: Record<string, string>
  readonly bytes: number
  readonly storedAt: number
}

export function attachCiphertextCache(ses: Session): void {
  const dir = ciphertextCacheDir()
  mkdirSync(dir, { recursive: true, mode: CACHE_DIR_MODE })

  ses.protocol.handle('https', async (request) => {
    const key = deriveCacheKey(request.url)
    if (key === null) return passthrough(request)

    /**
     * 分片请求不参与缓存。
     *
     * 上游对视频等大文件会发 Range 请求，而那意味着我们要正确处理 206、
     * Content-Range 与部分内容拼接 —— 复杂度与出错面都远高于收益。
     * 放行它们只是"视频仍然联网播放"，而错误地回应一个 Range 请求会让播放直接坏掉。
     */
    if (request.method !== 'GET' || request.headers.has('range')) {
      return passthrough(request)
    }

    const id = createHash('sha256').update(key).digest('hex')
    const { body: bodyPath, meta: metaPath } = cacheEntryPaths(dir, id)

    const cached = readCached(bodyPath, metaPath)
    if (cached !== null) {
      logger.debug('capture: ciphertext cache hit')
      return cached
    }

    const response = await passthrough(request)

    // 只缓存成功的、完整的响应。失败与 3xx 落盘没有意义，还会污染缓存。
    if (response.ok) {
      persist(bodyPath, metaPath, request.url, response)
    }

    return response
  })

  setCiphertextCacheActive(true)
  logger.info('capture: ciphertext layer attached', { dir })

  // TODO(M3)：容量上限与淘汰。当前实现只增不减，达到上限时会无声地吃掉磁盘。
  // 实现要点见 docs/media-capture.md 第 3 节：超限先淘汰，仍不够则退化为直通，
  // 而不是让请求失败。
}

/**
 * 原样回源。
 *
 * `bypassCustomProtocolHandlers` 是必需的：不带它，`net.fetch` 会再次进入我们
 * 自己的处理器，形成无限递归（表现为请求挂死）。
 */
function passthrough(request: Request): Promise<Response> {
  return net.fetch(request, { bypassCustomProtocolHandlers: true })
}

function readCached(bodyPath: string, metaPath: string): Response | null {
  if (!existsSync(bodyPath) || !existsSync(metaPath)) return null

  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as CachedMeta

    // 旧格式（当前是 version 缺失或不是 2）不回放：它的响应头语义可能已经不成立。
    if (meta.version !== CACHE_VERSION) {
      logger.debug('capture: cache entry has an older format, refetching')
      return null
    }

    const stream = Readable.toWeb(createReadStream(bodyPath)) as ReadableStream<Uint8Array>

    return new Response(stream, { status: 200, headers: meta.headers })
  } catch (error) {
    // 元信息损坏时不要报错给页面 —— 删掉缓存项，让它去回源。
    logger.warn('capture: cache entry unreadable, will refetch', {
      reason: (error as Error).name,
    })
    return null
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
