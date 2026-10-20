/**
 * 页面自己那条通知：从**内核层**把它的 API 拿掉（[ADR-0094]）。
 *
 * ── 要解决的是什么（用户报的是"内部 WhatsApp 显示需要开启通知"）──
 *
 * [ADR-0093] 之后页面自己的消息通知改由我们发，于是 `notifications` 权限在运行期**恒拒**
 * （`permissions.ts` 的 `notificationsReplaced`）。代价是 `Notification.permission` 变成
 * `denied` —— 而网页版自己会检测这个值：它在 `WAWebPushNotificationsGatingUtils` 里有一个
 * 判据（原文摘录，见 ADR-0094 的取证），大意是
 *
 * ```
 * permission === "default" || (permission === "denied" && <Chrome 系 UA>)
 * ```
 *
 * 为真就挂一条「去浏览器里开启通知」的提示条。Electron 的 UA 是 Chrome 系的，`denied` 又正好
 * 是我们自己造成的 ⇒ 那条提示**永远在**，而且它上面那个"开启"按钮调 `requestPermission()`
 * 也被我们拒（真机日志里那一行 `permission denied {"permission":"notifications"}` 就是它），
 * 于是点不掉、也不可能被满足。
 *
 * ── 这个开关做了什么（真机探针实测，Electron 44.7.0 / Chromium 152）──
 *
 * `--disable-notifications` 不是"授权但静默"，而是把 `Notification` **整个接口**从渲染进程里
 * 移除：探针页里 `typeof Notification === 'undefined'`。网页版那条判据读到的是 `undefined`
 * （`globalThis.Notification?.permission`），两个分支都不成立 ⇒ **提示条不再出现**。
 * 真机核对过两次启动的日志：不加开关时启动十几秒内会有 `permission check denied` 与
 * `permission denied` 两条 `notifications` 记录，加上之后**一条都没有**（页面根本没再碰这项权限）。
 *
 * ── 代价与边界 ──
 *
 *   1. **主进程的 `Notification` 不受影响**（探针实测：`show` 事件照发、D-Bus 上 `Notify` 照出现）
 *      —— 我们自己发的那几条（「N 条未读」/ 接管失效 / 词典失败 / 全屏提示）照旧能弹、能点回窗口。
 *   2. **它与 [ADR-0093] 的 `notificationsReplaced` 是一对**：将来若真要做"用回页面通知"的回退
 *      开关，必须**同时**撤掉这个开关，否则页面连 API 都没有，回退会变成一个静默的空功能。
 *   3. **用户自己写了这个开关就不动**（`hasSwitch`，不是 `getSwitchValue`：布尔开关不带 `=` 时
 *      后者返回空串，与"没写"分不开 —— 与 `smooth-scroll.ts` / `gpu-crash-limit.ts` 同一条坑）。
 *   4. **只在启动期生效**：命令行解析之后就固定了，因此必须在 `whenReady` 之前追加。
 *   5. **上游会看到的是"这个浏览器没有通知能力"**，而不是"通知被拒"。网页版设置页里那一行
 *      文案会变成什么样**没有验过**（见 ADR-0094 的"待验证"）—— 但两种都不如实测过的那条提示条
 *      更重要：它是常驻的，设置页不是。
 *
 * 纯函数 + 可注入的命令行接口（与 `app.commandLine` 同形），因此能单测，不必真起一个内核。
 */

/**
 * 内核开关名。
 *
 * 在二进制里核对过（照 [ADR-0036] / [ADR-0090] 的做法）：对本机 Electron 的
 * `dist/electron` 跑 `strings … | grep -x -c disable-notifications` 得 1。上游改名的症状是
 * "那条提示条又回来了"，而且命令行上多一个没人认识的开关，Chromium 只忽略它 —— 不会报错。
 */
export const PAGE_NOTIFICATIONS_SWITCH = 'disable-notifications'

/**
 * 我们用到的那部分 `app.commandLine`。
 *
 * 只需要这两个方法：一个用来判断"用户自己写了吗"，一个用来追加。
 * 与另外几个启动期开关模块（`smooth-scroll.ts` / `linux-gpu.ts` / `gpu-crash-limit.ts`）同形，
 * 刻意各自声明：每个模块都要能在没有任何依赖的情况下单独加载与单测。
 */
export interface CommandLineLike {
  hasSwitch(name: string): boolean
  appendSwitch(name: string): void
}

/**
 * 追加开关，返回**是否真的动了命令行**（调用方据此记一条日志）。
 */
export function applyPageNotificationSuppression(cli: CommandLineLike): boolean {
  if (cli.hasSwitch(PAGE_NOTIFICATIONS_SWITCH)) return false

  cli.appendSwitch(PAGE_NOTIFICATIONS_SWITCH)

  return true
}
