/**
 * 平滑滚动的单测（`src/main/smooth-scroll.ts`，[ADR-0081]）。
 *
 * 为什么值得测：这一项**只能**在启动期决定，而它写错的三个方向都不会报错 ——
 *
 *   1. **该写的时候没写**：设置里关掉了，页面照旧带缓动滚动。用户会当成 bug 反复拨那个开关，
 *      而每一次都"看起来生效了"（复选框确实变了）；
 *   2. **不该写的时候写了**：命令行上多一个没人认识的开关，Chromium 静默忽略 —— 只是噪音，
 *      但它会让下一次查这件事的人以为"我们确实请求了"；
 *   3. **覆盖掉用户显式传的那一份**：命令行同名开关以最后一次为准，"用户自己想要的"被我们
 *      替换掉，而命令行是他唯一能自己动手的地方（[ADR-0038] 第 4 条同源）。
 *
 * ⚠️ 判据必须靠 `hasSwitch()`：这两个开关都是**布尔开关**，用户写
 * `--disable-smooth-scrolling`（不带 `=`）时 `getSwitchValue()` 返回空串 —— 与"用户没写"
 * 分不开。因此假对象刻意同时提供两种读取方式，而用例里只喂裸开关名。
 *
 * 命令行是注入的假对象（与 `app.commandLine` 同形），因此这里既不需要 Electron，
 * 也不会真的改到进程的开关。
 */

import { describe, expect, it } from 'vitest'

import {
  NO_SMOOTH_SCROLLING_SWITCH,
  SMOOTH_SCROLLING_SWITCH,
  applySmoothScrolling,
  type CommandLineLike,
} from '../../src/main/smooth-scroll'

/** 与 `app.commandLine` 同形的假对象，记录 appendSwitch 的调用。 */
function fakeCli(explicit: readonly string[] = []): CommandLineLike & {
  readonly appended: string[]
} {
  const switches = new Set(explicit)
  const appended: string[] = []

  return {
    appended,
    hasSwitch: (name) => switches.has(name),
    appendSwitch: (name) => {
      appended.push(name)
      switches.add(name)
    },
  }
}

describe('applySmoothScrolling', () => {
  it('开启（默认）时一个开关都不写 —— 内核的默认就是它', () => {
    const cli = fakeCli()

    // 返回 false = "没有动命令行"。这一侧与"还没有这一项设置之前"逐字节相同。
    expect(applySmoothScrolling(cli, true)).toBe(false)
    expect(cli.appended).toEqual([])
  })

  it('关闭时写 --disable-smooth-scrolling，并告诉调用方真的动了命令行', () => {
    const cli = fakeCli()

    expect(applySmoothScrolling(cli, false)).toBe(true)
    expect(cli.appended).toEqual([NO_SMOOTH_SCROLLING_SWITCH])
  })

  it('用户显式传了这两个开关中的任何一个 ⇒ 一个字节都不动（显式选择优先）', () => {
    for (const explicit of [SMOOTH_SCROLLING_SWITCH, NO_SMOOTH_SCROLLING_SWITCH]) {
      const cli = fakeCli([explicit])

      // 两个方向都不动：设置说"关"时不覆盖他的 `--enable-…`，设置说"开"时也不去
      // 抹掉他的 `--disable-…`（后者是这一项唯一的逃生通道）。
      expect(applySmoothScrolling(cli, false)).toBe(false)
      expect(applySmoothScrolling(cli, true)).toBe(false)
      expect(cli.appended).toEqual([])
    }
  })
})
