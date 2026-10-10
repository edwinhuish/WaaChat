/**
 * 「禁用 PDF 预览」挡下一次预览时的**用户可见提示**（文案 + 节流判据）。
 *
 * 为什么需要它：开启这个开关之后，点击 PDF **不会**得到一份文件 —— 上游的预览面板仍然会打开
 * （那是页面自己的界面，我们没有注入就改不了，[INV-1]），而面板里那份内容被我们挡掉了，于是
 * 它**停在加载态**。实测与取舍见 [ADR-0041]：既拦不住那个面板，也不能让它替我们把文件交出去。
 *
 * 因此唯一的出路是**明确告诉用户该怎么做**：回到聊天，用消息上的「下载」把文件取到本地 ——
 * 那一步会走接管点 A（归档 → 系统默认阅读器）。没有这条提示时，用户看到的是"点了没反应"，
 * 而 `docs/architecture.md` 第 5 节把这种"安静地不起作用"列为最糟的失败模式。
 *
 * 放在 `shared/` 的理由与 `size-limit.ts` 相同：**判据要能被离线断言**。通知这类东西的两种
 * 坏法都不会有人报：刷屏（每次点击弹一次，一次点击里还会来好几个请求）与从不出现（节流写死）。
 */

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
