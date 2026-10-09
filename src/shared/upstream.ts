/**
 * "上游域"的判据。
 *
 * 这里回答的是**三个不同的问题**，答案故意不一样 —— 不要合并成一个函数：
 *
 *   站内 / 站外     上游自己的页面（含 `whatsapp.net` 下的辅助页）必须留在应用内。
 *                   用在 window.ts 的窗口打开处理上。
 *
 *   权限来源        只认承载登录态的那**一个源**。用在 session.ts 的权限白名单上
 *                   （docs/security.md T5）。
 *
 *   文档预览页      上游的 PDF 预览页属于"站内"，但本应用**不加载**它（[ADR-0029]）：
 *                   它的唯一作用是把 PDF 交给内核内置阅读器渲染，而本应用的契约是
 *                   "文件交给系统应用打开"。判据见 {@link isDocumentPreviewPage}。
 *
 * ⚠️ 三者都必须**解析 URL 后比较 host / origin**，不能写 `startsWith`：
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
 * `whatsapp.net` 下既有辅助页（预览、静态资源），也有媒体 CDN。这里的判据只回答
 * "是不是上游自己的页面"，**不是**媒体缓存的判据 —— 后者见 ADR-0015 与
 * capture/cachekey.ts（两者收窄的方向相反：这里宁滥勿缺，那里宁缺勿滥）。
 */
const UPSTREAM_AUX_HOST_SUFFIX = '.whatsapp.net'

/**
 * 上游文档预览页的路径前缀。
 *
 * 实测（[ADR-0029]）：这个页面的作用就是把 PDF 交给内核的**内置阅读器**渲染。因此它在
 * 本应用里一律不加载 —— 窗口那一层由 `main/window.ts` 拒绝，子框架那一层由
 * `main/capture/pdf.ts` 的请求拦截取消。
 */
const DOCUMENT_PREVIEW_PATH = '/pdf-viewer/'

/** 是否来自承载上游页面的那个源。权限只认它。 */
export function isUpstreamOrigin(rawUrl: string): boolean {
  const parsed = tryParse(rawUrl)
  return parsed !== null && parsed.origin === UPSTREAM_ORIGIN
}

/** 是否是上游自己的页面（站内）。 */
export function isUpstreamPage(rawUrl: string): boolean {
  const parsed = tryParse(rawUrl)
  return parsed !== null && isUpstreamHost(parsed.hostname)
}

/**
 * 是否是上游的**文档预览页**。
 *
 * 它在 {@link isUpstreamPage} 的意义上"属于上游"，但我们不加载它：那是把 PDF 送进内核
 * 内置阅读器的入口，而本应用要把文件交给系统应用（[ADR-0029]）。单独一个函数而不是把
 * 它并进 {@link isUpstreamPage} 的反例，是因为**两者举反例的方向不同** —— 站内判据漏一个
 * 源只是"某个页面打不开"，删掉预览页的方向上放宽一点点就会让应用内重新出现 PDF 预览。
 *
 * 判据是"上游域 + 这个路径"，**不限定哪个 host**：预览页落在哪个上游域上是对方的事
 * （实测在 `webtp` 上），写死 host 的话它换一个域我们就静默放行了。
 */
export function isDocumentPreviewPage(rawUrl: string): boolean {
  const parsed = tryParse(rawUrl)
  if (parsed === null) return false
  if (!isUpstreamHost(parsed.hostname)) return false

  return parsed.pathname.startsWith(DOCUMENT_PREVIEW_PATH)
}

/** host 判据只有这一处，三个函数共用（写错的后果见文件头）。 */
function isUpstreamHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === UPSTREAM_HOST || host.endsWith(UPSTREAM_AUX_HOST_SUFFIX)
}

function tryParse(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl)
  } catch {
    return null
  }
}
