/**
 * 缓存键推导。
 *
 * 这是接管点 B（密文缓存）里最容易出错的一环，因此单独成模块，做成**纯函数** ——
 * 不导入 electron、不做 IO，可以直接单测（test/unit/cachekey.test.ts）。
 *
 * 设计约束（docs/media-capture.md 第 3 节）：
 *
 *   宁可漏命中，不可错命中。
 *
 * 漏命中的代价是"又下载了一次"；错命中的代价是用户打开到一个**解不开的文件**。
 * 后者严重得多，因此凡是拿不准的参数一律**保留在键里**，只剔除确知会变化的。
 */

/**
 * 媒体 CDN 的 host 判据（收窄的理由与证据见 [ADR-0015]）。
 *
 * **不能用整个 `whatsapp.net`。** 实测（同一台机器上的真实缓存）：161 条缓存里有
 * 98 条是 `static.`（上游 JS / CSS / 字体）、`webtp.`（文档预览页）、`flows.`
 * 下的网页资源 —— 它们是**明文**，落进"密文缓存"既违背 docs/security.md 里对
 * `cache/` 的性质声明，也绕过了 Chromium 自己的 HTTP 缓存重校验：上游发版后
 * 页面可能长期加载到旧模块。
 *
 * **也不能写死单个 host。** 上游在多个 CDN 域之间切换（实测同时出现
 * `media-hkg1-1` / `media-hkg1-2` / `media-hkg4-1` / `media-hkg4-2`），
 * 因此按**后缀**匹配整个 CDN 域，只把已知的裸域名单独列出。
 *
 * 判据是白名单：漏判只会"又下载一次"，误判才会污染缓存，因此新域名一律先不加。
 */
const MEDIA_CDN_SUFFIX = '.cdn.whatsapp.net'

/** 已知的裸媒体域（当前网络下没有流量，保留是为了区域差异）。 */
const MEDIA_HOSTS: ReadonlySet<string> = new Set(['mmg.whatsapp.net'])

function isMediaHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host.endsWith(MEDIA_CDN_SUFFIX) || MEDIA_HOSTS.has(host)
}

/**
 * 确知"每次请求都可能不同"且与内容无关的查询参数。
 *
 * - `oh` / `oe`：签名与有效期。含进去会导致缓存永不命中。
 * - `ccb`：内容分发类的提示参数。
 * - `_nc_hot` / `_nc_cat` / `_nc_oc`：命中率提示，与内容无关。
 *
 * 加入新条目需要**实测依据**：必须确认该参数变化时对象本身没变。
 * 猜错的后果见文件头。
 */
const VOLATILE_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'oh',
  'oe',
  'ccb',
  '_nc_hot',
  '_nc_cat',
  '_nc_oc',
  '_nc_sid',
])

/** 媒体请求是否属于我们要接管的范围。 */
export function isMediaRequest(rawUrl: string): boolean {
  const parsed = tryParse(rawUrl)
  if (parsed === null) return false
  return parsed.protocol === 'https:' && isMediaHost(parsed.hostname)
}

/**
 * 推导稳定缓存键。返回 `null` 表示"不该走缓存"（非媒体请求、或 URL 无法解析）。
 *
 * 返回值形如 `host/path?稳定参数`。**不在这里做哈希** —— 哈希是 IO 层的事，
 * 保持本模块纯粹，以便单测直接比较字符串。
 */
export function deriveCacheKey(rawUrl: string): string | null {
  const parsed = tryParse(rawUrl)
  if (parsed === null || !isMediaRequest(rawUrl)) return null

  const stable = stableQuery(parsed)
  const base = `${parsed.hostname.toLowerCase()}${parsed.pathname}`

  return stable === '' ? base : `${base}?${stable}`
}

/**
 * 去掉易变参数，其余按字典序排列。
 *
 * 排序是必要的：查询参数的顺序在不同请求间不保证稳定，不排序会让同一个对象
 * 产生多个键，表现为"缓存时好时坏"——这种间歇性失效极难排查。
 */
export function stableQuery(url: URL): string {
  const pairs: Array<[string, string]> = []

  for (const [key, value] of url.searchParams.entries()) {
    if (VOLATILE_QUERY_PARAMS.has(key)) continue
    pairs.push([key, value])
  }

  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  return pairs.map(([key, value]) => `${key}=${value}`).join('&')
}

function tryParse(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl)
  } catch {
    return null
  }
}
