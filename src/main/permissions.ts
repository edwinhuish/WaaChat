/**
 * 权限白名单（**双向**：来源 + 类型）。
 *
 * 白名单而不是黑名单：上游将来申请一个新权限时，默认结果是"拒绝"，而不是静默放行
 * （[ADR-0035]）。两半都必须对：
 *
 *   - **来源**只认承载登录态的那**一个源**（{@link isUpstreamOrigin} 做 origin 精确比对）。
 *     同一个分区里还有我们自己的本地界面窗口；而前缀匹配会让
 *     `https://web.whatsapp.com@evil.com/` 通过 —— 摄像头与麦克风就交给了一个第三方页面
 *     （`docs/security.md` T5）。
 *   - **类型**逐项判断。下面每一项都有它自己的理由，**加一项必须带证据**：[ADR-0035] 里有一张
 *     取证清单（哪些权限对应上游的哪个功能、症状是什么、怎么从日志取证）。
 *
 * ── 为什么单独一个模块 ──
 *
 * 它是**安全关键、又只能靠读代码确认**的那一类判据。`session.ts` 顶层导入 electron，离线自检
 * 与单测都进不去；这里只 `import type`，于是"哪些权限被放行"变成可以被断言的约定 —— 将来有人
 * 放宽它，自检会先变红（`ai/CONVENTIONS.md` 第 8 节）。
 */

import type { Session } from 'electron'

import { isUpstreamOrigin } from '../shared/upstream'

/**
 * Electron 认得的权限名 —— **从它自己的签名推导**，不手抄一份。
 *
 * 手抄一份的代价是安静的：Electron 改名或新增时我们不会知道，而白名单里写错一个名字**不会
 * 报错** —— 它只是永远匹配不上，症状是"某个权限永远被拒"。推导出来之后，写错就是编译错误。
 */
type PermissionHandler = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>
type PermissionType = Parameters<PermissionHandler>[1]

/**
 * 放行的权限类型。
 *
 * ⚠️ 往这里加东西之前先读 [ADR-0035] 的取证清单：**没有证据就不加**。"顺手放开"正是
 * `docs/security.md` T5 要防的写法。
 */
export const ALLOWED_PERMISSIONS: ReadonlySet<PermissionType> = new Set<PermissionType>([
  /** 页面自己的消息通知 —— 托盘常驻就是为了让它能到达。 */
  'notifications',
  /** 麦克风 / 摄像头：通话与语音消息。 */
  'media',
  /**
   * 把文本写进剪贴板（"复制"按钮）。
   *
   * ⚠️ 刻意**不**包含 `clipboard-read`：DOM 的 `paste` 事件不需要它，需要它的是
   * `navigator.clipboard.read*` —— 那才是"静默读用户剪贴板"的能力。
   */
  'clipboard-sanitized-write',
  /** 全屏（通话与媒体查看器）。 */
  'fullscreen',
  /**
   * "这份存储不要被淘汰"（[ADR-0035]）：它不授予任何能力，只影响 Chromium 对本分区里该源
   * 自己数据的淘汰策略 —— 而那里存着登录态与消息库（[ADR-0008] 的立场：绝不代用户清除）。
   * 拒绝它的症状可能是消息历史重新同步，最坏情况要重新扫码。
   */
  'persistent-storage',
])

/**
 * 这个权限请求该不该放行。
 *
 * @param permission 请求的权限类型。Electron 会给字符串；上游将来引入的新类型也会原样传进来 ——
 *   不在白名单里的一律拒绝（这正是白名单的意义）
 * @param requestingOrigin 发起方的 origin。空串、非法值、以及非上游源一律拒绝
 * @param options 运行期的用户覆盖（见下）。**默认空对象**，因此"只看白名单"的调用点与断言
 *   （单测、离线自检）一行都不用改。
 */
export function isPermissionAllowed(
  permission: string,
  requestingOrigin: string,
  options: { readonly notificationsMuted?: boolean } = {},
): boolean {
  if (!isUpstreamOrigin(requestingOrigin)) return false

  /**
   * **免打扰**（[ADR-0082]）是**运行期**的用户覆盖，与白名单是两件事 —— 但它必须与白名单在
   * **同一处**判：让两个处理器（请求 / 检查）各自拼一遍"白名单 + 免打扰"，症状就是那一对
   * 相反的不一致（"检查通过、请求被拒"或反过来），而它恰好只在通话那种场合才暴露出来。
   *
   * ⚠️ 只覆盖 `notifications` 一项：免打扰要的是"别弹通知"，而 `media`（麦克风 / 摄像头）
   * 被顺手拒掉的后果是通话直接连不上 —— 那是另一件事。
   */
  if (options.notificationsMuted === true && permission === 'notifications') return false

  // 断言只在这里出现，而且只是为了查表：调用方传来的可能是 Electron 不认识的新值，
  // `has()` 对它会自然返回 false。
  return ALLOWED_PERMISSIONS.has(permission as PermissionType)
}
