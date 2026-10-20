/**
 * 「减少打扰」的两个**运行期**开关：静音应用声音、免打扰（暂停通知，[ADR-0082]）。
 *
 * ── 为什么是运行期状态，而不是两项设置 ──
 *
 * 它们是"现在这一刻"的意愿（在开会、在录音、临时不想被打断），而不是一份长期偏好 ——
 * 与「退出时清除归档」那种"装一次就不动"的项刚好相反。落盘还会带来一个更糟的可能：
 * 用户在某次启动里静音、忘了，几周后才发现；**一个不打扰的开关静默地一直开着，
 * 比它每次重启复位更难发现**。因此这里只有一个进程内的状态，重启回到"都不静音"。
 *
 * 两个开关的**机制完全不同**，这一点必须写清楚 —— 它们的生效时机也不一样：
 *
 *   1. **静音**落到主窗口的 `webContents.setAudioMuted()` 上：内核真的把这一扇页面的音频
 *      静掉了（通知提示音、语音消息、通话都在这条路上）。它是**确定生效**的。
 *   2. **免打扰**落到**我们自己发的那条「有新消息」通知**上（`notice.ts` 的
 *      `announceNewMessages`）。这是唯一"不碰页面还能少掉通知"的办法 —— 我们不拦截、
 *      不伪造页面自己的通知（INV-1），也不去动系统的通知守护进程（那是桌面的事）。
 *      ⚠️ 它原本落在**权限层**（拒掉页面的 `notifications`，[ADR-0082]）。那条路在 [ADR-0093]
 *      之后已经空了：页面自己的消息通知被整体替代，权限层再拒什么都拦不到。搬过来之后它还
 *      顺带修好了一个旧限制 —— 原先"已经加载完的页面要等它重新发起权限检查"才生效，
 *      现在**立刻生效**（判断发生在每次要弹通知的那一刻）。
 *      ⚠️ 它**只拦「有新消息」那一条**。接管失效、词典下载失败、全屏提示不归它管：那三条是
 *      我们自己发现的问题，属于"允许失效、不允许静默失效"，而免打扰的意思是
 *      "别人的消息别吵我"，不是"别告诉我应用坏了"。
 */

import type { BrowserWindow } from 'electron'

import { logger } from './logger'

/** 两个运行期开关的当前状态。`false` = 不静音 / 通知照常。 */
export interface QuietState {
  /** 页面的音频是否被静掉（通知提示音、语音消息、通话都在这条路上）。 */
  readonly audioMuted: boolean
  /** 是否不弹「有新消息」那条通知（[ADR-0093] 起，它不再作用于页面的通知权限）。 */
  readonly notificationsMuted: boolean
}

let state: QuietState = { audioMuted: false, notificationsMuted: false }

/**
 * 当前状态：托盘菜单的勾选态与权限判据都读它，**没有第二个事实源**。
 *
 * ⚠️ 也正因为如此，改它的地方必须**只有托盘菜单那一处**（自检断言了这一点）：勾选态是
 * `Menu.buildFromTemplate` 时读一次的快照，第二个入口若只改状态而不重建菜单，界面上那个勾
 * 就会与真实状态不一致 —— 而那种不一致没有任何报错。
 */
export function quietState(): QuietState {
  return state
}

/** 静音 / 取消静音，并把它落到那扇窗口上。 */
export function setAudioMuted(window: BrowserWindow, muted: boolean): void {
  state = { ...state, audioMuted: muted }

  /**
   * 窗口可能已经被销毁（用户在退出流程里点了托盘）。那时**只改状态**：为一行日志把退出流程
   * 弄崩不值得，而"静音没落到一扇正在销毁的窗口上"本来也没有意义。
   */
  if (!window.isDestroyed()) window.webContents.setAudioMuted(muted)

  logger.info('quiet: audio mute changed', { muted })
}

/** 开启 / 关闭免打扰。 */
export function setNotificationsMuted(muted: boolean): void {
  state = { ...state, notificationsMuted: muted }

  logger.info('quiet: notifications mute changed', { muted })
}
