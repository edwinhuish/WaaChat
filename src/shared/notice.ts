/**
 * 主动提示用户的那几条消息：**文案与"该不该弹"的判据**（纯函数，可单测）。
 *
 * 目前有三条，前两条都是"用户看不见就会以为应用坏了"的事：**接管失效**与**拼写词典没下载下来**
 * （`architecture.md` 第 5 节：允许失效，不允许静默失效）。前者以前靠设置窗口顶栏那几颗标签，
 * 其中"尚无接管记录"既没有信息量又占地方，整个顶栏因此被去掉（[ADR-0042]）—— 换成**只在真的
 * 失效时**说一次。
 *
 * 第三条（页面进入全屏，[ADR-0084]）不是"失效"，而是"用户可能找不到出口"：全屏之后没有窗口
 * 装饰，而 Wayland 下更看不到任何可点的地方。它的判据因此与上面两条不同 —— 见那一节。
 *
 * 第四条（有新消息，[ADR-0093]）与前三条的来历都不同：它不是我们**发现**的问题，而是替页面
 * 发它发不下去的那一条 —— 页面自己的通知点击之后窗口不动（见 `main/notice.ts` 文件头）。
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

// ---------------------------------------------------------------------------
// 页面进入了全屏（通话 / 媒体查看器）
// ---------------------------------------------------------------------------

/**
 * 全屏提示的标题。**说出发生了什么**，而不是"提示"。
 */
export const FULLSCREEN_HINT_TITLE = '页面进入了全屏'

/**
 * 正文：**给出唯一的下一步动作**。
 *
 * ⚠️ 只写 `Esc`，不要顺手把 `F11` 也带上：`F11` 是我们自己那条「窗口全屏」（[ADR-0077] 的应用
 * 菜单），它**不会**把页面从 HTML 全屏里退出来 —— 写进去的后果是用户按了没用，然后连这条提示
 * 一起不信。而 `Esc` 由内核的全屏控制器处理（浏览器里那个"按 Esc 退出全屏"就是它）。
 *
 * 也不写"点击这里"之类：我们没有可点的地方，这条提示的全部价值就是告诉用户那个键。
 */
export const FULLSCREEN_HINT_BODY = '要退出全屏，按 Esc。'

/** {@link trackFullscreenHint} 的结果。与 {@link CaptureFailureTracking} 同形（只是状态更简单）。 */
export interface FullscreenHintTracking {
  readonly announce: boolean
  /** 新的"已经提示过"状态。 */
  readonly announced: boolean
}

/**
 * 全屏提示的簿记（纯函数）。规则：**每个进程只提示一次**。
 *
 * ⚠️ 这条规则与上面两条都不同，理由是这里的触发源**太频繁**：上游进 HTML 全屏的场合不止通话
 * —— 点开一张图（媒体查看器）也会。每次进入都弹一次的后果是"看几张图就被弹几次"，而通知被
 * 用户关掉之后，接管失效那条真正要命的提示也一起没了。因此宁可少说：**一次运行里说一次**，
 * 那恰好是"用户第一次遇到这件事、最可能不知道怎么办"的那一次。
 *
 * 也不做"恢复正常后重新武装"：这里没有"恢复正常"这回事（退出全屏是用户自己按的）。
 *
 * @param announced 这个进程里是否已经提示过
 */
export function trackFullscreenHint(announced: boolean): FullscreenHintTracking {
  return { announce: !announced, announced: true }
}

// ---------------------------------------------------------------------------
// 有新消息（[ADR-0093]）
// ---------------------------------------------------------------------------

/**
 * 新消息通知的标题。
 *
 * ⚠️ **说不出是谁发的**，而这正是这条通知的代价：发送者与消息摘要在页面手里，读它就是读页面
 * （INV-1 / [ADR-0086]）。于是这里与页面自己那条通知的差别，恰好就是"谁发的"这一整块。
 */
export const NEW_MESSAGES_TITLE = '有新消息'

/**
 * 正文：**只有总数**。
 *
 * 不写"又有 1 条新消息"：我们的读数来自页面标题，那个数字是**未读总数**，不是这一次事件的
 * 增量（5 → 6 说的是"现在有 6 条未读"，不是"刚来了一条"）。把它当增量写出来，用户会以为
 * 丢了消息。
 */
export function newMessagesBody(count: number): string {
  return `现在共有 ${count} 条未读消息。点这里回到聊天窗口。`
}

/** {@link shouldAnnounceNewMessages} 的输入，全部来自主进程已经知道的只读事实。 */
export interface NewMessageSignal {
  /** 上一次已知的未读数；`null` = 还不知道（启动后还没读到，或者刚刚读完、标题里没有前缀）。 */
  readonly previous: number | null
  /** 这次读到的未读数；`null` = 标题里没有 `(N)` 前缀。 */
  readonly current: number | null
  /** 主窗口此刻是否**在前台**（可见且有焦点）。 */
  readonly foreground: boolean
}

/**
 * 该不该为新消息弹一条通知（纯函数）。
 *
 * 两条**同时**成立才弹：
 *
 *   1. **未读数上升了**（`current > previous`，`null` 按 0 算 —— 那表示"没有已知未读"，
 *      而不是"不知道现在几条"）。只看上升，因此读掉几条（5 → 3）或者读完清零（5 → `null`）
 *      都不会弹。
 *   2. **窗口不在前台**。这一条是必须的，而且它同时解决三件事：
 *      - 启动时页面报上来的那个数（昨天没读完的 5 条）不是"新消息"，而这时窗口通常是可见的；
 *      - 用户正看着窗口时他自己看得见，再弹一次是重复；
 *      - 而**托盘常驻自启**（启动即隐藏）那种情形恰恰相反 —— 那时它确实该弹，而判据会照办。
 *
 * ⚠️ 不要把它改成"每次标题变化都弹"：标题会被切会话、上游的定时器频繁重写，而计数通常没变。
 */
export function shouldAnnounceNewMessages(signal: NewMessageSignal): boolean {
  if (signal.foreground) return false
  if (signal.current === null) return false

  return signal.current > (signal.previous ?? 0)
}
