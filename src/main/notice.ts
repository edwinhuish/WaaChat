/**
 * 主动提示用户（系统通知）。
 *
 * 为什么单独一个模块：它 import `Notification`（electron），因此**不能**待在
 * `capture/health.ts` 里 —— 那个模块只 `import type` electron，离线自检要能直接引用它
 * （`ai/CONVENTIONS.md` 第 8 节）。判据与文案留在 `shared/notice.ts`（纯函数，可单测）。
 * 于是分工是：**判据可断言、IO 只此一处**。
 *
 * 为什么是通知而不是界面上的标签：设置窗口原来顶栏挂着"接管状态"（[ADR-0025] 理由 5）。那几颗
 * 标签里"尚无接管记录"没有信息量、正常状态也没有，而**真的失效**时用户未必正看着那扇窗口。
 * 顶栏整个去掉之后（[ADR-0042]），失效改走这条通道：平时一声不响，出事时弹一次。
 *
 * 也不是弹窗：弹窗会打断且必须点掉，而这件事只是"提个醒"。这与页面自己的消息通知走同一条
 * 通道（`permissions.ts` 允许 `notifications`）。
 *
 * **点击通知 = 把那扇窗口带到用户面前**（[ADR-0092]）。这一条**必须我们自己写**：Linux 上
 * Electron 不提供任何"点击通知 → 激活窗口"的默认行为，连网页通知被点击时它也只有一个
 * "派发给页面"的动作。目的地由 `index.ts` 注入（见 `setNoticeActivation()`）。
 */

import { Notification } from 'electron'

import {
  CAPTURE_FAILED_TITLE,
  FULLSCREEN_HINT_BODY,
  FULLSCREEN_HINT_TITLE,
  SPELLCHECK_DICTIONARY_FAILED_TITLE,
  captureFailureBody,
  spellcheckDictionaryFailureBody,
  trackCaptureFailure,
  trackDictionaryFailure,
  trackFullscreenHint,
} from '../shared/notice'
import type { CaptureFailure } from '../shared/types'
import { logger } from './logger'

/** 已经提示过的**失效种类**。接管恢复正常时清空（见 `shared/notice.ts` 的两条规则）。 */
let announcedFailures: ReadonlySet<string> = new Set()

/**
 * 点开通知之后要带到用户面前的那扇窗口。
 *
 * `main` 是聊天（应用的主体）；`settings` 是设置页 —— 只有它上面有"词典失败"那一行的
 * 「重试」按钮（[ADR-0091]），把用户送到别处等于让他自己再找一遍。
 */
type NoticeTarget = 'main' | 'settings'

/**
 * 两个目的地的实现，**由装配处注入**（`index.ts`）。
 *
 * 为什么是注入而不是这里直接 import `./window`：本模块的职责是"弹什么"，窗口是另一件事。
 * 这与 `watchSpellcheck()` 接受 `announceDictionaryFailure` 回调是同一种分工 —— 也避免了
 * `notice → window → …` 这条 import 链在将来某次重构里绕回来。
 */
let activation: Record<NoticeTarget, () => void> = {
  main: () => {},
  settings: () => {},
}

/**
 * 注入"点击通知之后做什么"。
 *
 * ⚠️ **必须自己注入并调用**：Linux 上 Electron **不会**因为点击通知而激活窗口。
 * 网页通知的点击只派发给页面（`platform_notification_service.cc` 的
 * `NotificationDelegateImpl::NotificationClick()` → `DispatchNonPersistentClickEvent`），
 * 主进程通知也只有 `Notification` 的 `click` 事件 —— 两边都没有"把窗口带到前面"这一步。
 * 页面侧的 `window.focus()` 也救不回来：实测窗口最小化时它连 `visible` 都不会变
 * （`BrowserWindow::OnActivateContents()` 只隐藏自动隐藏的菜单）。
 */
export function setNoticeActivation(handlers: Record<NoticeTarget, () => void>): void {
  activation = handlers
}

/**
 * 还活着的通知。
 *
 * ⚠️ 这个集合是必需的，不是备忘：主进程的 `Notification` 一旦被 GC，`click` 事件就**再也
 * 不会来**（JS 对象被回收后，C++ 那边回调无处可派）。症状是"通知还在屏幕上，点它毫无反应"
 * —— 而且只在大约几十条之后、GC 跑过的时候才出现，最难查。
 *
 * `close` 会把它移出集合（Linux 上这个事件不保证发出，见 electron.d.ts），因此再加一道
 * 上限：超了就丢掉最早的那一条。丢掉的那一条如果还挂在通知中心里，点击会无效，但 64 条
 * 同存已经是极端情况（而对象本身只有几百字节，不丢也撑不爆）。
 */
const live = new Set<Notification>()

/** 同时保留引用的通知条数上限，见 {@link live}。 */
const LIVE_LIMIT = 64

/** 弹一条通知。返回是否真的弹了 —— 桌面没有通知服务时不算弹过。 */
function show(title: string, body: string, target: NoticeTarget = 'main'): boolean {
  try {
    if (!Notification.isSupported()) {
      // 纯 WM 的会话、容器里跑：记一条日志，而不是假装提示过了。
      logger.warn('notice: this desktop has no notification service', { title })
      return false
    }

    const notification = new Notification({ title, body })

    if (live.size >= LIVE_LIMIT) {
      const oldest = live.values().next().value
      if (oldest !== undefined) live.delete(oldest)
    }
    live.add(notification)

    const forget = (): void => {
      live.delete(notification)
    }

    /**
     * 点击 = "让我看看"。这是这一条通道**唯一**的出路：通知本来就只说一句"出事了"，
     * 用户点它是因为想处理，而不是想再看一遍那行字。窗口收在哪（最小化 / 关闭到托盘）
     * 由 `presentWindow()` 两步都试，这里不重复判断。
     */
    notification.on('click', () => {
      forget()
      activation[target]()
    })

    // Linux 上不保证发出（electron.d.ts 的原话），所以它只是"顺手清一下"。
    notification.on('close', forget)

    notification.show()
    return true
  } catch (error) {
    logger.warn('notice: could not show a notification', { reason: (error as Error).name })
    return false
  }
}

/**
 * 提示"接管失效了" —— `architecture.md` 第 5 节那条"允许失效，不允许静默失效"的落点
 * （[ADR-0042] 之后它是**唯一**的界面告知渠道）。
 *
 * 由 `main/session.ts` 订阅 `onHealthChange` 调用：**每种失效只提示一次**，直到接管恢复正常
 * 才重新武装（规则与理由见 `shared/notice.ts`）。
 */
export function announceCaptureFailure(failure: CaptureFailure): void {
  const tracking = trackCaptureFailure(announcedFailures, failure)
  announcedFailures = tracking.announced

  if (!tracking.announce) return

  // ⚠️ 正文里的人话来自 `describeCaptureFailure()`（与界面同一份），因此不会出现
  // "日志里说 A、通知里说 B"这种分叉。
  if (show(CAPTURE_FAILED_TITLE, captureFailureBody(failure))) {
    logger.info('notice: told the user that the capture layer failed', { kind: failure.kind })
  }
}

/** 接管恢复正常（`markCaptured`）：把"已经提示过"清空，下次失效会重新提示。 */
export function markCaptureHealthy(): void {
  announcedFailures = trackCaptureFailure(announcedFailures, null).announced
}

/**
 * 已经提示过的**词典语言码**。
 *
 * 与 {@link announcedFailures} 不同，这一组**不重新武装**，理由在 `shared/notice.ts` 的
 * {@link trackDictionaryFailure} 里：词典下载失败会被内核在每次输入时重试，成功之前一直失败。
 */
let announcedDictionaryFailures: ReadonlySet<string> = new Set()

/**
 * 提示"某门拼写词典没能下载"。
 *
 * 由 `main/session.ts` 在 `spellcheck-dictionary-download-failure` 上调用 —— 事件订阅在
 * `spellcheck.ts`（它只 `import type` electron，见那里的说明），通知**回调注入**进来。
 *
 * 它与接管失效同源（**允许失效，不允许静默失效**），但更难自己发现：接管失效至少还能在
 * `~/Downloads` 里看到那个文件，而词典没下来时设置页一切正常，只是输入框里少了那几条红线。
 *
 * 日志那一半由调用方记（那里知道事件的上下文），这里只负责"要不要打扰用户"。
 */
export function announceDictionaryFailure(languageCode: string): void {
  const tracking = trackDictionaryFailure(announcedDictionaryFailures, languageCode)
  announcedDictionaryFailures = tracking.announced

  if (!tracking.announce) return

  if (
    show(
      SPELLCHECK_DICTIONARY_FAILED_TITLE,
      spellcheckDictionaryFailureBody(languageCode),
      'settings',
    )
  ) {
    logger.info('notice: told the user that a spellcheck dictionary could not be downloaded', {
      language: languageCode,
    })
  }
}

/** 这个进程里是否已经提示过全屏（见 `shared/notice.ts` 的 `trackFullscreenHint`）。 */
let announcedFullscreenHint = false

/**
 * 提示"页面进了全屏、按 Esc 退出"（[ADR-0084]）。
 *
 * 由 `main/fullscreen.ts` 订阅 `enter-html-full-screen` 调用。**每个进程只说一次** ——
 * 上游进全屏的场合不止通话（点开一张图也会），每次都说会把通知吵到被关掉，而那条通道上还挂着
 * 接管失效的告警。
 *
 * ⚠️ 它**不受托盘那个「免打扰」影响**：后者拒绝的是**页面**的通知权限
 * （`notifications`，见 `permissions.ts`），而这条通知是我们自己在主进程里发的 —— 这也正是
 * 这条提示该有的性质：免打扰的意思是"别人的消息别吵我"，不是"别告诉我怎么退出全屏"。
 */
export function announceFullscreenHint(): void {
  const tracking = trackFullscreenHint(announcedFullscreenHint)
  announcedFullscreenHint = tracking.announced

  if (!tracking.announce) return

  if (show(FULLSCREEN_HINT_TITLE, FULLSCREEN_HINT_BODY)) {
    logger.info('notice: told the user how to leave full screen')
  }
}
