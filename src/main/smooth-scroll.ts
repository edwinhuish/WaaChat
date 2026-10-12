/**
 * 平滑滚动（[ADR-0081]）。
 *
 * 内核默认开启平滑滚动，而它**只能在启动期决定**：Chromium 的两个开关
 * （`--enable-smooth-scrolling` / `--disable-smooth-scrolling`）在命令行解析之后就固定了。
 * 页面里没有合法的替代杠杆 —— 改滚动行为属于"注入样式"，那是 INV-1 的红线。
 *
 * ⚠️ **开关名在二进制里核对过**（照 [ADR-0036] 的做法）：对
 * `node_modules/.pnpm/electron@44.7.0…/node_modules/electron/dist/electron` 跑 `strings`，
 * 再 `grep smooth-scrolling`，得到两行 —— `disable-smooth-scrolling` 与
 * `enable-smooth-scrolling`。两个都留着（一个用来关，一个用来判断"用户自己写了吗"）。
 *
 * （路径里的 `…` 是省略号，**不是**通配符：在 `44.7.0` 后面接一个星号再跟路径分隔符，会在
 * 这个块注释里凑出注释的结束符，把注释提前结束掉 —— 那是一次**编译期**就会报出来的错误，
 * 但值得在这里说明为什么这里不写通配符。）
 *
 * 取证值得留一条记录，因为上游改名/删掉它的症状是"这一项设置从此**静默**不起作用"：
 * 命令行上多了一个没人认识的开关，Chromium 只会忽略它。
 *
 * ── 两条边界 ──
 *
 *   1. **显式开关优先。** 用户自己传了这两个里的任何一个，我们就一个字节都不动 —— 与
 *      [ADR-0038] 第 4 条同源（"显式选择优先于我们的默认"）。它同时是这一项唯一的逃生通道：
 *      设置里关掉之后想当场要回平滑滚动，自己写 `--enable-smooth-scrolling` 即可。
 *   2. **"开着"什么都不写。** 内核的默认就是开，因此这一侧不追加任何开关 —— 与"还没有这一项
 *      设置之前"逐字节相同。只有关掉才写 `--disable-smooth-scrolling`。
 *
 * 纯函数 + 可注入的命令行接口（与 `app.commandLine` 同形），因此能单测，不必真的启动内核
 * （与 `linux-gpu.ts` 同一个形状，理由也相同）。
 */

/** 用户自己写了这两个里的任何一个时，我们不再插手（边界 1）。 */
export const SMOOTH_SCROLLING_SWITCH = 'enable-smooth-scrolling'
export const NO_SMOOTH_SCROLLING_SWITCH = 'disable-smooth-scrolling'

/**
 * 我们用到的那部分 `app.commandLine`。
 *
 * ⚠️ 这里必须用 `hasSwitch()` 而不是 `getSwitchValue()`：这两个都是**布尔开关**，而用户写
 * `--disable-smooth-scrolling`（不带 `=`）时 `getSwitchValue()` 返回空串，与"用户没写"
 * 分不开 —— 偏偏这是最常见的一种写法，判错的后果是"用户显式传的开关被我们覆盖掉"。
 */
export interface CommandLineLike {
  hasSwitch(name: string): boolean
  appendSwitch(name: string): void
}

/**
 * 需要时追加开关，返回**是否真的动了命令行**（调用方据此记一条日志）。
 *
 * `enabled`（默认值）为 `true` 时什么都不做，理由见文件头边界 2。
 */
export function applySmoothScrolling(cli: CommandLineLike, enabled: boolean): boolean {
  if (cli.hasSwitch(SMOOTH_SCROLLING_SWITCH) || cli.hasSwitch(NO_SMOOTH_SCROLLING_SWITCH)) {
    return false
  }

  if (enabled) return false

  cli.appendSwitch(NO_SMOOTH_SCROLLING_SWITCH)

  return true
}
