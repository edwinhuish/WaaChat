/**
 * GPU 崩溃计数开关的单测（[ADR-0090]）。
 *
 * 覆盖三件"改坏了不会立刻发现"的事：
 *
 *   1. **默认要真的把它加上** —— 漏掉的症状是"注销时那次崩溃照旧"（一年也不一定遇到一次）；
 *   2. **用户自己写了就不动** —— 判断必须走 `hasSwitch`：布尔开关不带 `=` 时
 *      `getSwitchValue` 返回空串，与"没写"分不开；
 *   3. **重复调用是幂等的** —— 装配路径多调一次不该追加两个同名开关。
 *
 * 命令行是注入的假对象，因此这里不需要 Electron。
 */

import { describe, expect, it } from 'vitest'

import {
  applyGpuCrashTolerance,
  GPU_CRASH_LIMIT_SWITCH,
  type CommandLineLike,
} from '../../src/main/gpu-crash-limit'

/** 与 `app.commandLine` 同形的假对象，记录 appendSwitch 的调用。 */
function fakeCli(initial: string[] = []): CommandLineLike & { readonly appended: string[] } {
  const present = new Set(initial)
  const appended: string[] = []

  return {
    appended,
    hasSwitch: (name) => present.has(name),
    appendSwitch: (name) => {
      appended.push(name)
      present.add(name)
    },
  }
}

describe('applyGpuCrashTolerance', () => {
  it('默认追加那一个开关，并报告动了命令行', () => {
    const cli = fakeCli()

    expect(applyGpuCrashTolerance(cli)).toBe(true)
    expect(cli.appended).toEqual([GPU_CRASH_LIMIT_SWITCH])
  })

  it('用户自己写了就不再动（布尔开关按存在判断）', () => {
    const cli = fakeCli([GPU_CRASH_LIMIT_SWITCH])

    expect(applyGpuCrashTolerance(cli)).toBe(false)
    expect(cli.appended).toEqual([])
  })

  it('重复调用幂等：只追加一次', () => {
    const cli = fakeCli()

    expect(applyGpuCrashTolerance(cli)).toBe(true)
    expect(applyGpuCrashTolerance(cli)).toBe(false)
    expect(cli.appended).toEqual([GPU_CRASH_LIMIT_SWITCH])
  })
})
