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
 */

import { Notification } from 'electron'

import { CAPTURE_FAILED_TITLE, captureFailureBody, trackCaptureFailure } from '../shared/notice'
import type { CaptureFailure } from '../shared/types'
import { logger } from './logger'

/** 已经提示过的**失效种类**。接管恢复正常时清空（见 `shared/notice.ts` 的两条规则）。 */
let announcedFailures: ReadonlySet<string> = new Set()

/** 弹一条通知。返回是否真的弹了 —— 桌面没有通知服务时不算弹过。 */
function show(title: string, body: string): boolean {
  try {
    if (!Notification.isSupported()) {
      // 纯 WM 的会话、容器里跑：记一条日志，而不是假装提示过了。
      logger.warn('notice: this desktop has no notification service', { title })
      return false
    }

    new Notification({ title, body }).show()
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
