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
  /**
   * 页面自己的消息通知。
   *
   * ⚠️ 把它留在白名单里**不等于它会放行**：运行期覆盖恒拒（见下面
   * {@link PermissionOptions.notificationsReplaced}，[ADR-0093]）。这一行说的是"这项能力
   * 本身不危险"，而拒绝它的是另一件事 —— 那条通知已经改由我们发。
   */
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
 * 页面自己发通知的那项权限。
 *
 * ⚠️ 它仍然在白名单里，但**运行期恒被拒**（{@link PermissionOptions.notificationsReplaced}，
 * [ADR-0093]）：拒绝它的不是"这个能力危险"，而是"这条通知已经被我们替代了"。两者要分开写，
 * 因为将来若真要做"用回页面通知"的开关，需要知道这项能力本身是**允许的**。
 */
const PAGE_NOTIFICATION_PERMISSION: PermissionType = 'notifications'

/**
 * 运行期覆盖（与白名单是两件事，但必须在**同一处**判）。
 *
 * 让两个处理器（请求 / 检查）各自拼一遍"白名单 + 覆盖"，症状就是那一对相反的不一致
 * （"检查通过、请求被拒"或反过来），而它恰好只在通话那种场合才暴露出来。
 */
export interface PermissionOptions {
  /** 「免打扰」（[ADR-0082]）：用户在此刻不想被打扰。 */
  readonly notificationsMuted?: boolean
  /**
   * 页面自己的消息通知已由主进程接管（[ADR-0093]）。
   *
   * ⚠️ 这一个**不是用户的意愿**，而是装配事实 —— 它与 {@link notificationsMuted} 指向同一条
   * 权限、理由却完全不同：页面那条通知在 Linux 上点击之后窗口不会动（[ADR-0092]），而
   * `notice.ts` 自己发的那一条点了就回窗口。两条同时存在只会让用户收到两份、且只有一份能用。
   *
   * 因此它**恒为 `true`**（见 `session.ts` 的 `permissionOverride()`）。留在选项里而不是把
   * `notifications` 从白名单里删掉，是为了保留"用回页面通知"这个回退点。
   */
  readonly notificationsReplaced?: boolean
}

/**
 * 这个权限请求该不该放行。
 *
 * @param permission 请求的权限类型。Electron 会给字符串；上游将来引入的新类型也会原样传进来 ——
 *   不在白名单里的一律拒绝（这正是白名单的意义）
 * @param requestingOrigin 发起方的 origin。空串、非法值、以及非上游源一律拒绝
 * @param options 运行期的用户覆盖（见上）。**默认空对象**，因此"只看白名单"的调用点与断言
 *   （单测、离线自检）一行都不用改。
 */
export function isPermissionAllowed(
  permission: string,
  requestingOrigin: string,
  options: PermissionOptions = {},
): boolean {
  if (!isUpstreamOrigin(requestingOrigin)) return false

  /**
   * 两个理由、同一个落点：**免打扰**是用户此刻不想被打扰（[ADR-0082]），而**通知已被替代**是
   * 这条通道已经改由我们自己发（[ADR-0093]）。
   *
   * ⚠️ `notificationsMuted` 这一项在这里**已经是冗余的**（`notificationsReplaced` 恒真，它
   * 自己就能拒）。留着它有两个理由：一是它把这句意愿钉在它原本的落点上，读代码的人能看见
   * 免打扰仍然管着权限层；二是将来真要做"用回页面通知"的开关时，`replaced` 一旦关掉，
   * 免打扰必须立刻仍然生效 —— 那时候删掉这一行就是一个静默的功能回退。
   *
   * ⚠️ 只覆盖 `notifications` 一项：免打扰要的是"别弹通知"，而 `media`（麦克风 / 摄像头）
   * 被顺手拒掉的后果是通话直接连不上 —— 那是另一件事。
   */
  if (permission === PAGE_NOTIFICATION_PERMISSION) {
    if (options.notificationsMuted === true || options.notificationsReplaced === true) return false
  }

  // 断言只在这里出现，而且只是为了查表：调用方传来的可能是 Electron 不认识的新值，
  // `has()` 对它会自然返回 false。
  return ALLOWED_PERMISSIONS.has(permission as PermissionType)
}
