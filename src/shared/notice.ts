/**
 * 主动提示用户的那几条消息：**文案与"该不该弹"的判据**（纯函数，可单测）。
 *
 * 目前只有一条，都是"用户看不见就会以为应用坏了"的事：**接管失效**
 * （`architecture.md` 第 5 节：允许失效，不允许静默失效）。以前这条靠设置窗口顶栏那几颗标签，
 * 其中"尚无接管记录"既没有信息量又占地方，整个顶栏因此被去掉（[ADR-0042]）—— 换成**只在真的
 * 失效时**说一次。
 *
 * ── 为什么"该不该弹"也在这里 ──
 *
 * 通知这类东西的坏法都不会有人报：刷屏（一次失败的接管会每点一个文件重演一次）与从不出现
 * （判据写死）。把判据放进纯函数，单测与离线自检就能钉住边界；IO（`Notification`）留在
 * `main/notice.ts`。
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
