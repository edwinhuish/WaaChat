/**
 * Linux 启动期 GPU 开关的单测（[ADR-0036] / [ADR-0038]）。
 *
 * 覆盖五件"改坏了没人会立刻发现"的事：
 *
 *   1. **只在 Wayland 上动** —— 判断错的代价是在本来能用 Vulkan 的 X11 上把它关掉；
 *   2. **不覆盖用户的 `--disable-features`** —— 同名开关以最后一次为准，直接写会静默抹掉
 *      用户自己的列表；
 *   3. **两个开关都要落下**：只关 feature 是不够的（Wayland 那行报错的真正来源是 WebGPU 的
 *      「原生 Vulkan + GL 互操作」路，它不是 `base::Feature`）—— 这是 1.0.3 实测踩过的坑；
 *   4. **用户显式要求 Vulkan 时不动**，**用户自己指定了 WebGPU 后端时也不动那个开关**
 *      —— 显式选择优先；
 *   5. 拿不准（环境变量缺失、显式开关为空）时**宁可不动**。
 *
 * 命令行是注入的假对象，因此这里既不需要 Electron，也不会真的改到进程的开关。
 */

import { describe, expect, it } from 'vitest'

import {
  applyLinuxGpuSwitches,
  type CommandLineLike,
  userRequestedVulkan,
  usesWaylandOzone,
} from '../../src/main/linux-gpu'

/** 与 `app.commandLine` 同形的假对象，记录 appendSwitch 的调用。 */
function fakeCli(switches: Record<string, string> = {}): CommandLineLike & {
  readonly appended: [string, string][]
} {
  const current = { ...switches }
  const appended: [string, string][] = []

  return {
    appended,
    getSwitchValue: (name) => current[name] ?? '',
    appendSwitch: (name, value) => {
      appended.push([name, value])
      current[name] = value
    },
  }
}

describe('usesWaylandOzone', () => {
  it('显式开关优先于会话', () => {
    // 用户在 Wayland 会话里显式要 x11：那就不是 Wayland 路径。
    expect(
      usesWaylandOzone({ ozonePlatform: 'x11', sessionType: 'wayland', waylandDisplay: ':0' }),
    ).toBe(false)
    // 反过来：X11 会话里显式要 Wayland。
    expect(usesWaylandOzone({ ozonePlatform: 'wayland', sessionType: 'x11' })).toBe(true)
  })

  it('没有显式开关时看会话', () => {
    expect(usesWaylandOzone({ ozonePlatform: '', sessionType: 'wayland' })).toBe(true)
    expect(usesWaylandOzone({ ozonePlatform: '', waylandDisplay: 'wayland-0' })).toBe(true)
    expect(usesWaylandOzone({ ozonePlatform: '', sessionType: 'x11' })).toBe(false)
  })

  it('拿不准时返回 false（宁可不动）', () => {
    expect(usesWaylandOzone({ ozonePlatform: '' })).toBe(false)
    expect(usesWaylandOzone({ ozonePlatform: '', sessionType: '', waylandDisplay: '' })).toBe(false)
  })

  it('大小写与空格不影响判断', () => {
    expect(usesWaylandOzone({ ozonePlatform: ' WayLand ' })).toBe(true)
    expect(usesWaylandOzone({ ozonePlatform: '', sessionType: 'Wayland' })).toBe(true)
  })
})

describe('userRequestedVulkan', () => {
  it('认得出显式要求（含 VulkanFromANGLE 这类同族名字）', () => {
    expect(userRequestedVulkan('Vulkan')).toBe(true)
    expect(userRequestedVulkan('Foo,VulkanFromANGLE')).toBe(true)
    expect(userRequestedVulkan('Foo,Bar')).toBe(false)
    expect(userRequestedVulkan('')).toBe(false)
  })
})

describe('applyLinuxGpuSwitches', () => {
  it('Wayland 上既关 Vulkan feature，也把 WebGPU 从原生 Vulkan 上挪开', () => {
    const cli = fakeCli()

    expect(applyLinuxGpuSwitches(cli, { waylandDisplay: 'wayland-0' })).toBe(true)
    expect(cli.getSwitchValue('disable-features')).toBe('Vulkan,DefaultANGLEVulkan,VulkanFromANGLE')
    // 第二个开关才是那行报错的真正来源：WebGPU 的「原生 Vulkan + GL 互操作」不是 feature，
    // 只关 feature 时实测那行照旧出现（1.0.3）。
    expect(cli.getSwitchValue('use-webgpu-adapter')).toBe('opengles')
  })

  it('不覆盖用户已有的 --disable-features，而是合并在前面', () => {
    // appendSwitch 同名以最后一次为准：直接写会把用户自己那份列表静默抹掉。
    const cli = fakeCli({ 'disable-features': 'UserFeature' })

    applyLinuxGpuSwitches(cli, { sessionType: 'wayland' })

    expect(cli.getSwitchValue('disable-features')).toBe(
      'UserFeature,Vulkan,DefaultANGLEVulkan,VulkanFromANGLE',
    )
  })

  it('用户自己指定过 WebGPU 后端时不动那个开关（逃生通道）', () => {
    // `--use-webgpu-adapter=vulkan` 是想要"原生 Vulkan + GL 互操作"的人自己写上的，
    // 盖掉它等于替用户改主意；代价是那行 ERROR 会回来，而那是他的选择。
    const cli = fakeCli({ 'use-webgpu-adapter': 'vulkan' })

    applyLinuxGpuSwitches(cli, { sessionType: 'wayland' })

    expect(cli.getSwitchValue('use-webgpu-adapter')).toBe('vulkan')
    // 但同一层之外的那条（GL / 合成的 Vulkan）仍然照关不误。
    expect(cli.getSwitchValue('disable-features')).toBe('Vulkan,DefaultANGLEVulkan,VulkanFromANGLE')
  })

  it('X11 上一个开关都不动', () => {
    const cli = fakeCli()

    expect(applyLinuxGpuSwitches(cli, { sessionType: 'x11' })).toBe(false)
    // 显式要 X11：即使会话本身是 Wayland 也不动（生效的是那个显式开关）。
    expect(
      applyLinuxGpuSwitches(fakeCli({ 'ozone-platform': 'x11' }), { waylandDisplay: 'wayland-0' }),
    ).toBe(false)
    expect(cli.appended).toHaveLength(0)
    expect(cli.getSwitchValue('use-webgpu-adapter')).toBe('')
  })

  it('用户显式要求 Vulkan 时不动（显式选择优先）', () => {
    const cli = fakeCli({ 'enable-features': 'Vulkan' })

    expect(applyLinuxGpuSwitches(cli, { sessionType: 'wayland' })).toBe(false)
    expect(cli.appended).toHaveLength(0)
    expect(cli.getSwitchValue('use-webgpu-adapter')).toBe('')
  })
})
