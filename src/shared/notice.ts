/**
 * 主动提示用户的那几条消息：**文案与"该不该弹"的判据**（纯函数，可单测）。
 *
 * 目前两条，都是"用户看不见就会以为应用坏了"的事：
 *
 *   1. **接管失效**（`architecture.md` 第 5 节：允许失效，不允许静默失效）。以前这条靠设置窗口
 *      顶栏那几颗标签，其中"尚无接管记录"既没有信息量又占地方，整个顶栏因此被去掉（[ADR-0042]）
 *      —— 换成**只在真的失效时**说一次。
 *   2. **PDF 预览被挡下**（[ADR-0041]）：开启「禁用 PDF 预览」后，上游那个预览面板仍会打开并停在
 *      加载态，用户需要知道改走消息上的「下载」。
 *
 * ── 为什么"该不该弹"也在这里 ──
 *
 * 通知这类东西的坏法都不会有人报：刷屏（一次点击会引发一串事件）与从不出现（判据写死）。
 * 把判据放进纯函数，单测与离线自检就能钉住边界；IO（`Notification`）留在 `main/notice.ts`。
 */

import { describeCaptureFailure } from './format'
import type { CaptureFailure } from './types'

// ---------------------------------------------------------------------------
// 接管失效
// ---------------------------------------------------------------------------

/** 失效提示的标题。**说出是哪件事**，而不是"出错了"。 */
export const CAPTURE_FAILED_TITLE = '接管失效'

/** 失效提示的正文：与界面用**同一份**人话（`shared/format.ts`），因此两处不会说法分叉。 */
export function captureFailureBody(failure: CaptureFailure): string {
  return describeCaptureFailure(failure)
}

/** {@link trackCaptureFailure} 的结果：这次弹不弹、以及记完之后的状态。 */
export interface CaptureFailureTracking {
  readonly announce: boolean
  /** 新的"已经提示过的失效种类"集合。 */
  readonly announced: ReadonlySet<string>
}

/**
 * 接管失效提示的簿记（纯函数）。规则两条：
 *
 *   1. **每种失效只提示一次**：磁盘满、上游改版这类失败会**每点一次文件就重演一次**，按时间
 *      节流会在修好之前反复打扰用户（他多半已经在查了）；而"每次都不弹"又会让第一次也看不见。
 *      用"种类"做键：同一种原因不再重复，**换了一种原因仍然会提示** —— 后者恰恰是要让人看见的。
 *   2. **接管恢复正常就重新武装**（`failure === null`）：否则同一个原因第二次出现时，我们不再说话。
 *
 * @param announced 已经提示过的失效种类
 * @param failure 刚发生的失效；`null` 表示这次是**成功**（`markCaptured`）
 */
export function trackCaptureFailure(
  announced: ReadonlySet<string>,
  failure: CaptureFailure | null,
): CaptureFailureTracking {
  if (failure === null) return { announce: false, announced: new Set() }

  return {
    announce: !announced.has(failure.kind),
    announced: new Set([...announced, failure.kind]),
  }
}

// ---------------------------------------------------------------------------
// PDF 预览被挡下
// ---------------------------------------------------------------------------

/** 通知标题。短，且直接说出"是哪个开关在起作用"。 */
export const PREVIEW_BLOCKED_TITLE = 'PDF 预览已禁用'

/**
 * 通知正文：**下一步做什么**。
 *
 * 刻意不解释实现（"端到端加密""内核阅读器"之类），那些写在设置项的说明与 `docs/usage.md` 里；
 * 用户此刻要的是一条可执行的出路。
 */
export const PREVIEW_BLOCKED_BODY =
  '这个 PDF 没有在应用内打开。请回到聊天，用消息上的「下载」把文件取到本地 —— 它会归档并用系统阅读器打开；已经下载过的可以在「文件列表」里找到。'

/** 两次提示之间的最小间隔（毫秒）。 */
export const PREVIEW_NOTICE_COOLDOWN_MS = 30_000

/**
 * 现在该不该弹这条提示。
 *
 * 一次点击 PDF 会引发一串被挡掉的请求（预览文档本身 + 它加载的 viewer SDK），因此按请求弹
 * 通知会立刻变成刷屏；而"只弹一次、之后再也不弹"又会让后来真正需要它的用户看不到。折中是
 * **按时间节流**。
 *
 * @param lastAt 上次提示的时刻；从没弹过是 `null`
 * @param now 当前时刻
 * @param cooldown 最小间隔，默认 {@link PREVIEW_NOTICE_COOLDOWN_MS}
 *
 * 时钟回拨（`now < lastAt`）按"刚弹过"处理：宁可少弹一次，也不要因为系统时间跳一下就刷屏。
 */
export function shouldAnnouncePreviewBlocked(
  lastAt: number | null,
  now: number,
  cooldown: number = PREVIEW_NOTICE_COOLDOWN_MS,
): boolean {
  if (lastAt === null) return true

  return now - lastAt >= cooldown
}
