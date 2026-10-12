/**
 * 未读计数（托盘徽标与窗口标题的输入，[ADR-0080]）。
 *
 * **数据源只有一个：页面标题。** 上游网页版在收到消息时会把 `document.title` 写成
 * `(3) WhatsApp`（读完清空后回到 `WhatsApp`），而 `document.title` 是**浏览器层的**事实 ——
 * 内核把它交给主进程（`webContents` 的 `page-title-updated`），因此我们一个字节都不用往页面里
 * 写（INV-1）。这也是本模块存在的理由：它是"不碰页面也能知道有没有未读"的唯一入口。
 *
 * ⚠️ 三条判据都必须遵守**"不认识就不猜"**：
 *
 *   1. **没有 `(N)` 前缀 → `null`（不知道），而不是 0。** 两者说的不是一件事：0 = "读到了、
 *      而且没有未读"，`null` = "没读到、不知道"。把它们混起来，一次上游改版就会让徽标显示成
 *      "0 条未读"这种我们并不掌握的事实。
 *   2. **前缀里不是纯数字 → `null`。** 宁可没有徽标，也不要显示一个错的数字。
 *   3. **上限 99。** 三位数在托盘图标上（约 22px）已经糊成一团；而 `99+` 传达的信息
 *      （"很多"）与"再来一条"没有区别。
 *
 * 纯函数（不 import electron），因此上面三条都能单测。
 */

/** 上游写在标题最前面的那个"（N）"。带前导空白容错：上游偶尔会先放一个空格。 */
const UNREAD_PREFIX = /^\s*\((\d{1,4})\)\s*/

/** 徽标上最多显示到这个数，再大就是 `99+`。 */
export const UNREAD_BADGE_LIMIT = 99

/**
 * 从页面标题里读出未读条数。
 *
 * 读不到就返回 `null` —— **包括** `(0) WhatsApp` 这种"上游明确说了没有未读"的情形：
 * 对调用方来说两者要做的都是"一个徽标都不画"，因此不需要第四种状态。
 */
export function parseUnreadCount(title: string): number | null {
  const matched = UNREAD_PREFIX.exec(title)
  if (matched === null) return null

  const count = Number(matched[1])
  return Number.isSafeInteger(count) && count > 0 ? count : null
}

/**
 * 徽标上的文字；`null` = 不画徽标。
 *
 * 单独一个函数而不是在托盘那边拼字符串：它是"99+"这条规则的唯一落点，而这条规则值得被单测
 * （越界一位就是一个画不下的徽标）。
 */
export function unreadBadgeLabel(count: number | null): string | null {
  if (count === null || !Number.isFinite(count) || count <= 0) return null
  return count > UNREAD_BADGE_LIMIT ? `${UNREAD_BADGE_LIMIT}+` : String(Math.trunc(count))
}

/**
 * 窗口标题：`WaaChat（工作）` → `WaaChat（工作） — 3 条未读`。
 *
 * 为什么要把未读写进标题：窗口列表与任务栏里看到的只有标题，而"哪个实例有未读"在只开着
 * 两三个窗口时是最常问的问题。另外它顺带解决了一个**既有**问题：页面加载完之后会把窗口标题
 * 覆盖成它自己的 `WhatsApp`，于是命名实例不再自报家门（[ADR-0062] 要的正是"一眼分清哪扇窗口
 * 是哪份数据"）。现在标题归我们管（`main/unread.ts` 拦下 `page-title-updated`），两件事一起解决。
 */
export function formatWindowTitle(base: string, count: number | null): string {
  const label = unreadBadgeLabel(count)
  return label === null ? base : `${base} — ${label} 条未读`
}
