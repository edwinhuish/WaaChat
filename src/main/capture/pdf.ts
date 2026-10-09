/**
 * PDF 一律交给系统应用 —— 不让内核的**内置阅读器**渲染它。
 *
 * 为什么需要这个模块：Electron 44 **没有**关掉内置 PDF 阅读器的开关。实测
 * `webPreferences.plugins`（`false` / `true` / 不设）、`--disable-plugins`、
 * `--disable-extensions`、`--disable-pdf-extension`、`--disable-features=PdfOopif`
 * 全部无效，`navigator.pdfViewerEnabled` 恒为 `true`（证据表见 [ADR-0029]）。
 * 因此"取消预览"只能等价于**不让 PDF 到达阅读器**：把它变成一次下载，交给接管点 A
 * （归档 → `shell.openPath` → 系统默认应用）。
 *
 * ── 两个挂点，各自覆盖一半 ──
 *
 * 理由是一条实测结论：**密文缓存那一层挂着时**（[ADR-0027]），会话里所有 https 都由
 * `protocol.handle('https')` 接住，此时
 *
 *   - `webRequest.onBeforeRequest` 的取消**仍然生效**（请求根本到不了协议处理器）
 *     → 挡上游的预览页；
 *   - `webRequest.onHeadersReceived` 却**改不动**那份响应（PDF 照旧被渲染）
 *     → 逼下载只能放到协议处理器内部（`capture/protocol.ts` 的 `passthrough()` 里调用
 *       {@link forceDownloadIfPdf}）。
 *
 * 缓存那一层摘掉时它不在路径上，同一个 MIME 判据由这里的 `onHeadersReceived` 兜住。
 *
 * ⚠️ **已知边界**：页面自己解密出来、做成 `blob:` 再交给内核的 PDF 够不着这里
 * （`<iframe src=blob:>` / `<embed src=blob:>` 不触发 `will-frame-navigate`，而
 * `downloadURL(blob:)` 在 Electron 44 上会把进程打崩）。完整说明与后果见 [ADR-0029]。
 */

import type { Session } from 'electron'

import { isDocumentPreviewPage } from '../../shared/upstream'
import { logger } from '../logger'

/** 告诉内核"这不是一份它能显示的东西"，于是它走下载而不是内嵌渲染。 */
export const PDF_DOWNLOAD_MIME = 'application/octet-stream'

/**
 * 这份响应的 MIME 是不是 PDF。
 *
 * 判据只看 MIME，不看 URL：上游的媒体 URL 里没有扩展名（`/v/t62…/NNNN.enc`），
 * 而"能不能显示"是内核按 MIME 决定的。带参数（`application/pdf; name=…`）也算。
 */
export function isPdfResponse(contentType: string | null | undefined): boolean {
  if (typeof contentType !== 'string') return false

  const [mime] = contentType.split(';')
  return (mime ?? '').trim().toLowerCase() === 'application/pdf'
}

/**
 * 把一份 PDF 响应改写成"下载"。
 *
 * **不复制字节**：只换 `content-type`，响应体（流）原样透传。实测这样 Chromium 立刻走
 * 下载，文件名与字节都正确（`will-download` 拿到的就是 `a.pdf`）。
 *
 * 只改这一项的意义：请求一个字节没动、响应体一个字节没动、页面的 JS 与 DOM 一行没碰
 * （[INV-1] 的边界是注入）。见 [ADR-0029] 的理由 4。
 */
export function forceDownloadIfPdf(response: Response): Response {
  if (!isPdfResponse(response.headers.get('content-type'))) return response

  const headers = new Headers(response.headers)
  headers.set('content-type', PDF_DOWNLOAD_MIME)

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * 装上这一层。
 *
 * 与密文缓存那一层不同，它**不随任何设置开关**：PDF 交给系统应用是本应用的契约
 * （README 第 1 节、roadmap 的 M1），不是可选项。
 *
 * 幂等：`webRequest` 的每个事件只保留最后一个监听器，重复调用只是覆盖成同一个实现。
 */
export function attachPdfHandling(ses: Session): void {
  // 上游的文档预览页。窗口那一层在 `main/window.ts` 拒绝，这里挡**子框架**那一层 ——
  // 实测它确实会被嵌进 `web.whatsapp.com` 的 iframe（那次 COEP 症状见 ADR-0016 的背景）。
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (!isDocumentPreviewPage(details.url)) {
      callback({})
      return
    }

    logger.warn('capture: blocked the upstream document preview page', {
      host: hostOf(details.url),
    })
    callback({ cancel: true })
  })

  // 缓存那一层**没挂**时，https 走的是原生网络栈，这份响应归 webRequest 管。
  // （挂着时这里是空转：协议处理器返回的响应就是最终响应，见模块头部的说明。）
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders
    const key = headers === undefined ? undefined : findHeader(headers, 'content-type')

    if (headers === undefined || key === undefined || !isPdfResponse(headers[key]?.[0])) {
      callback({})
      return
    }

    logger.info('capture: handing a PDF to the system app', { host: hostOf(details.url) })
    callback({ responseHeaders: { ...headers, [key]: [PDF_DOWNLOAD_MIME] } })
  })
}

/**
 * 头名大小写不敏感，但回传时**必须用原来的键名**：换一个大小写等于凭空多出一个头，
 * 而 Chromium 对重复的 `content-type` 取哪一个是不确定的。
 */
function findHeader(headers: Record<string, string[]>, wanted: string): string | undefined {
  return Object.keys(headers).find((name) => name.toLowerCase() === wanted)
}

/** 日志里只留 host：路径与查询串可能带签名与对象标识（INVARIANTS G-1）。 */
function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname
  } catch {
    return ''
  }
}
