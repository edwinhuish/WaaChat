/**
 * PDF 不进内核的**内置阅读器**，交给系统应用。
 *
 * 为什么需要这个模块：Electron 44 **没有**关掉内置 PDF 阅读器的开关。实测
 * `webPreferences.plugins`（`false` / `true` / 不设）、`--disable-plugins`、
 * `--disable-extensions`、`--disable-pdf-extension`、`--disable-features=PdfOopif`
 * 全部无效，`navigator.pdfViewerEnabled` 恒为 `true`（证据表见 [ADR-0029]）。
 * 因此"取消预览"只能等价于**不让 PDF 到达阅读器**：把它变成一次下载，交给接管点 A
 * （归档 → `shell.openPath` → 系统默认应用）。
 *
 * ── 两条规则都只在"禁用 PDF 预览"开着时生效 ──
 *
 * 这一层由设置 `disablePdfPreview` 控制，**默认关闭**（[ADR-0030]）：关着的时候上游的预览页
 * 照常加载、PDF 在应用内预览；打开之后才有下面两条规则 ——
 *
 *   1. 上游的**文档预览页**（`*.whatsapp.net/pdf-viewer/…`）不再加载；
 *   2. `application/pdf` 的响应降级成 `application/octet-stream`，于是内核走下载。
 *
 * ── 打开之后**实际**会发生什么（实测，[ADR-0041]）──
 *
 * 规则 2 如愿：PDF 不再被内核阅读器渲染，走下载 → 归档 → 系统阅读器。
 *
 * 规则 1 只挡住了**内容**：那个预览面板是上游页面自己的界面，不注入就改不了它（[INV-1]），
 * 于是它打开之后停在加载态 —— 用户看到的正是"点 PDF 一直转圈"。实测还排除了两条更漂亮的做法：
 * 把 `/pdf-viewer/…` 的请求 `redirectURL` 到 `about:blank` 或 `data:` 都被 Chromium 拒收
 * （`ERR_UNSAFE_REDIRECT`），因此**没法**把一段自己的说明塞进那个面板里。
 *
 * 于是只剩一件事可做：**明确告诉用户该怎么做**（`hooks.onPreviewBlocked` → 系统通知：
 * 回到聊天，用消息上的「下载」）。这比"点了没反应"好得多，也正是 [ADR-0041] 记录下来的取舍。
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
import type { Settings } from '../../shared/types'
import { hostOf, logger } from '../logger'

/** 告诉内核"这不是一份它能显示的东西"，于是它走下载而不是内嵌渲染。 */
export const PDF_DOWNLOAD_MIME = 'application/octet-stream'

/**
 * "禁用 PDF 预览"当前开着没有。
 *
 * 这不是设置的一份**副本**，而是 {@link attachPdfHandling} 注入的**实时读取函数**：注入读取
 * 函数而不是读一次快照，是因为用户在设置里改了它必须立刻生效（与接管层读 `openOnCapture`
 * 同一条纪律 —— "设置改了不起作用"这种问题很难被当成 bug 报出来）。
 */
let pdfPreviewDisabled: () => boolean = () => false

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
 * 把一份 PDF 响应降级成下载 —— **只在"禁用 PDF 预览"开着时**。
 *
 * **不复制字节**：只换 `content-type`，响应体（流）原样透传。实测这样 Chromium 立刻走下载，
 * 文件名与字节都正确（`will-download` 拿到的就是 `a.pdf`）。
 *
 * 只改这一项的意义：请求一个字节没动、响应体一个字节没动、页面的 JS 与 DOM 一行没碰
 * （[INV-1] 的边界是注入）。见 [ADR-0029] 的理由 4。
 */
export function forceDownloadIfPdf(response: Response): Response {
  if (!pdfPreviewDisabled()) return response
  if (!isPdfResponse(response.headers.get('content-type'))) return response

  const headers = new Headers(response.headers)
  headers.set('content-type', PDF_DOWNLOAD_MIME)

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** 这一层的可选副作用。注入而不是直接调用，是为了让本模块保持 electron-free（见文件头）。 */
export interface PdfHandlingHooks {
  /**
   * 挡下一次预览时调用（**每次命中都调**，节流在实现里）。
   *
   * 存在的理由是可观察性（[ADR-0041]）：被挡掉之后，页面那个预览面板会停在加载态，而它是
   * 上游的界面 —— 我们唯一能做的是**明确告诉用户改走消息上的「下载」**。没有这条提示，
   * 用户看到的就只是"点了没反应"。
   */
  readonly onPreviewBlocked?: () => void
}

/**
 * 装上这一层。
 *
 * 幂等：`webRequest` 的每个事件只保留最后一个监听器，重复调用只是覆盖成同一个实现。
 *
 * @param getSettings 读当前设置。**每个请求现读**（不在这里取快照）—— 开关必须改完立刻生效。
 */
export function attachPdfHandling(
  ses: Session,
  getSettings: () => Settings,
  hooks: PdfHandlingHooks = {},
): void {
  pdfPreviewDisabled = () => getSettings().disablePdfPreview

  // 上游的文档预览页。窗口那一层在 `main/window.ts` 拒绝，这里挡**子框架**那一层 ——
  // 实测它确实会被嵌进 `web.whatsapp.com` 的 iframe（那次 COEP 症状见 ADR-0016 的背景）。
  //
  // 判据不细分"预览文档本身"还是"它加载的 SDK 资源"（两者都在 `/pdf-viewer/` 下）：一次点击
  // 会引发一整串请求，逐条区分只会更脆；去重交给提示那一侧的节流（`shared/preview-notice.ts`）。
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (!pdfPreviewDisabled() || !isDocumentPreviewPage(details.url)) {
      callback({})
      return
    }

    logger.warn('capture: blocked the upstream document preview page', {
      host: hostOf(details.url),
    })
    hooks.onPreviewBlocked?.()

    callback({ cancel: true })
  })

  // 缓存那一层**没挂**时，https 走的是原生网络栈，这份响应归 webRequest 管。
  // （挂着时这里是空转：协议处理器返回的响应就是最终响应，见模块头部的说明。）
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders
    const key = headers === undefined ? undefined : findHeader(headers, 'content-type')

    if (
      !pdfPreviewDisabled() ||
      headers === undefined ||
      key === undefined ||
      !isPdfResponse(headers[key]?.[0])
    ) {
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
