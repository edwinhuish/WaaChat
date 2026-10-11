/**
 * 主动提示用户的那几条消息：**文案与"该不该弹"的判据**（纯函数，可单测）。
 *
 * 目前有两条，都是"用户看不见就会以为应用坏了"的事：**接管失效**与**拼写词典没下载下来**
 * （`architecture.md` 第 5 节：允许失效，不允许静默失效）。前者以前靠设置窗口顶栏那几颗标签，
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

// ---------------------------------------------------------------------------
// 拼写词典没能下载
// ---------------------------------------------------------------------------

/**
 * 词典下载失败的标题。**说出是哪件事**，而不是"出错了"（同 {@link CAPTURE_FAILED_TITLE}）。
 *
 * 它凭什么值一条通知：这一支**没有别的症状**。设置里写着「拼写检查：开启、词典：英语（美国）」，
 * 日志里除了我们故意加的那一条 warn 之外什么都没有，而输入框里一条红线都没有 —— 用户只会
 * 以为这个功能没做。词典来自第三方 CDN（`docs/security.md` 第 2 节），取不回来是**真实可能**
 * 的（[ADR-0061] 的已知限制里写着它）。
 */
export const SPELLCHECK_DICTIONARY_FAILED_TITLE = '拼写检查的词典没能下载'

/**
 * 正文。**给出下一步动作**，而不是"出错了"：用户能做的只有两件事 ——
 * 换一门词典，或者干脆关掉这个功能（关掉它同时也是"不要再去下载词典"的开关）。
 */
export function spellcheckDictionaryFailureBody(languageCode: string): string {
  return `「${languageCode}」这门词典没能从下载源取回来，这门语言的拼写不会被标注。可以在设置里换一门词典，或者关掉拼写检查。`
}

/** {@link trackDictionaryFailure} 的结果。与 {@link CaptureFailureTracking} 同形。 */
export interface DictionaryFailureTracking {
  readonly announce: boolean
  /** 新的"已经提示过的词典语言码"集合。 */
  readonly announced: ReadonlySet<string>
}

/**
 * 词典下载失败的簿记（纯函数）。规则：**同一门词典只提示一次**。
 *
 * ⚠️ 与 {@link trackCaptureFailure} 的关键差别是**没有"重新武装"**（那个函数有 `null` 那一支）。
 * 原因在内核那一侧：词典下载失败会被**每次输入时重试**，成功之前会一直失败 —— 若每次失败都
 * 弹一次通知，用户会在半分钟内把通知关掉，而那之后真正需要它的提示也看不到了。接管失效可以
 * "恢复正常后重新武装"，是因为它有一种明确的、由我们自己观测的成功事件；词典这边只有"这门
 * 语言的词典装好了"，而那是**另一门语言不会触发**的信号，做不成对称的样子。
 *
 * 键取**语言码**而不是布尔：勾了多门词典时，其中一门下不下来不该让另外几门的提示一起沉默。
 */
export function trackDictionaryFailure(
  announced: ReadonlySet<string>,
  languageCode: string,
): DictionaryFailureTracking {
  return {
    announce: !announced.has(languageCode),
    announced: new Set([...announced, languageCode]),
  }
}
