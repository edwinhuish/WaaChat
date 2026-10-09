/**
 * "上游域"的判据。
 *
 * 这里回答的是**两个不同的问题**，答案故意不一样 —— 不要合并成一个函数：
 *
 *   站内 / 站外     上游自己的页面（含 `whatsapp.net` 下的辅助页）必须留在应用内。
 *                   用在 window.ts 的窗口打开处理上。
 *
 *   权限来源        只认承载登录态的那**一个源**。用在 session.ts 的权限白名单上
 *                   （docs/security.md T5）。
 *
 * ⚠️ 两者都必须**解析 URL 后比较 host / origin**，不能写 `startsWith`：
 * `https://web.whatsapp.com.evil.com/` 与 `https://web.whatsapp.com@evil.com/`
 * 都能骗过前缀匹配，而后者还能把摄像头 / 麦克风权限交给一个第三方页面。
 *
 * 纯函数、不导入 electron —— 因此可以被单测与 `scripts/check-capture.ts` 直接使用
 * （见 ai/CONVENTIONS.md 第 8 节）。
 */

import { UPSTREAM_ORIGIN } from './constants'

/** 承载登录态的 host。由 {@link UPSTREAM_ORIGIN} 推导，避免两处各写一遍。 */
const UPSTREAM_HOST = new URL(UPSTREAM_ORIGIN).hostname

/**
 * 上游自有域的辅助页后缀。
 *
 * 文档预览（`webtp.whatsapp.net/pdf-viewer/`）这类页面与聊天页面同属上游，
 * 只是不在 `web.whatsapp.com` 上。它们被拒绝的后果是"点文档打不开预览"，
 * 而且我们还会把地址丢给系统浏览器 —— 那里没有登录态。
 *
 * ⚠️ 这**不是**媒体缓存的判据：`*.whatsapp.net` 里既有媒体 CDN 也有静态资源域，
 * 两者的取舍见 ADR-0015 与 capture/cachekey.ts。
 */
const UPSTREAM_AUX_HOST_SUFFIX = '.whatsapp.net'

/** 是否来自承载上游页面的那个源。权限只认它。 */
export function isUpstreamOrigin(rawUrl: string): boolean {
  const parsed = tryParse(rawUrl)
  return parsed !== null && parsed.origin === UPSTREAM_ORIGIN
}

/** 是否是上游自己的页面（站内）。 */
export function isUpstreamPage(rawUrl: string): boolean {
  const parsed = tryParse(rawUrl)
  if (parsed === null) return false

  const host = parsed.hostname.toLowerCase()
  return host === UPSTREAM_HOST || host.endsWith(UPSTREAM_AUX_HOST_SUFFIX)
}

function tryParse(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl)
  } catch {
    return null
  }
}
