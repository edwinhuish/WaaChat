/**
 * 全屏的退出提示（[ADR-0084]）。
 *
 * **为什么需要它**：上游进 HTML 全屏时（通话、媒体查看器），内核把那扇页面铺满整个屏幕 ——
 * 而那之后**没有任何可点的地方能退出来**。X11 下至少还有窗口装饰，Wayland 下连装饰都没有：
 * 用户看到的只是"应用把整个屏幕占了，不知道怎么回去"，而关掉窗口是我们设计的"隐藏到托盘"
 * （[ADR-0056]），于是连"点那个叉"这条退路都不成立。
 *
 * 在浏览器里这件事由浏览器自己解决（全屏时它会自己压一条"按 Esc 退出"的提示条）。我们承载的是
 * 网页版，而那一层**不存在于我们的窗口里** —— 因此这条提示只能我们自己给。
 *
 * ⚠️ 只说 `Esc`，不写 `F11`：后者是我们自己那条「窗口全屏」（[ADR-0077] 的应用菜单），它**不会**
 * 把页面从 HTML 全屏里退出来。
 *
 * 判据（"每个进程只说一次"）在 `shared/notice.ts` 的 `trackFullscreenHint`，IO 在
 * `main/notice.ts` —— 与另外两条提示同一套分工。
 */

import type { BrowserWindow } from 'electron'

import { logger } from './logger'
import { announceFullscreenHint } from './notice'

/**
 * 把这扇窗口的两个全屏事件接上。
 *
 * `enter-html-full-screen` / `leave-html-full-screen` 是**页面**发起的全屏（`Element.requestFullscreen`
 * 那条路），与 `F11` 触发的**窗口**全屏是两件事（后者走 `window.setFullScreen()`，内核不给我们
 * 这两个事件）—— 这正是我们只在这两个事件上挂提示的原因：`F11` 是用户自己按的，他当然知道。
 */
export function attachFullscreenHint(window: BrowserWindow): void {
  const contents = window.webContents

  contents.on('enter-html-full-screen', () => {
    logger.info('fullscreen: the page went full screen')
    announceFullscreenHint()
  })

  /**
   * 退出时也记一条，而且它不只是日志：这是"用户自己按了 Esc"这件事在我们这边**唯一**的观测点。
   * 没有它，"那条提示到底有没有用"就只能靠猜（[ADR-0084] 的"待验证"第 1 条要的就是这一条日志）。
   */
  contents.on('leave-html-full-screen', () => {
    logger.info('fullscreen: the page left full screen')
  })
}
