/**
 * 「减少打扰」两个运行期开关的单测（`src/main/quiet.ts`，[ADR-0082]）。
 *
 * 这里测的不是"状态存得对不对"（那就是两个布尔），而是两件会**安静**坏掉的事：
 *
 *   1. **静音要真的落到窗口上**：只改状态不落窗口的症状是"托盘里勾着静音，声音照旧" ——
 *      而界面看起来完全正常（那个勾就在那儿），用户会去调系统音量；
 *   2. **窗口已经销毁时不能抛**：用户在退出流程里点托盘那一刻会走到这条路上，
 *      为一行状态把退出流程弄崩不值得。
 *
 * 窗口是注入的假对象（只与 `BrowserWindow` 的那一小部分同形），因此这里既不需要 Electron，
 * 也不会真的去静音。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { BrowserWindow } from 'electron'

import {
  quietState,
  setAudioMuted,
  setNotificationsMuted,
  type QuietState,
} from '../../src/main/quiet'

interface FakeWindow {
  isDestroyed: () => boolean
  readonly webContents: { setAudioMuted: (muted: boolean) => void }
  /** 记录我们真的往窗口上写了什么。 */
  readonly mutedValues: boolean[]
}

function fakeWindow(): FakeWindow {
  const mutedValues: boolean[] = []

  return {
    isDestroyed: () => false,
    webContents: {
      setAudioMuted: (muted) => {
        mutedValues.push(muted)
      },
    },
    mutedValues,
  }
}

/** 假对象只有真对象的一小部分，因此这里必须显式转换（而不是让它悄悄通过）。 */
function asWindow(window: FakeWindow): BrowserWindow {
  return window as unknown as BrowserWindow
}

/** 每个用例从"都不静音"开始 —— 模块里的状态是进程级的，不能靠用例顺序。 */
beforeEach(() => {
  setAudioMuted(asWindow(fakeWindow()), false)
  setNotificationsMuted(false)
})

describe('quietState', () => {
  it('起步是"都不静音"', () => {
    expect(quietState()).toEqual({ audioMuted: false, notificationsMuted: false })
  })

  it('静音同时落到状态与那扇窗口上（只改状态＝界面正常、声音照旧）', () => {
    const window = fakeWindow()

    setAudioMuted(asWindow(window), true)

    expect(quietState().audioMuted).toBe(true)
    expect(window.mutedValues).toEqual([true])
  })

  it('免打扰只改状态：它落到权限判据上，绝不碰音频', () => {
    const window = fakeWindow()

    setNotificationsMuted(true)

    expect(quietState().notificationsMuted).toBe(true)
    // 顺手把声音也静掉的症状是"语音消息听不见了" —— 与"少弹通知"是两件事。
    expect(quietState().audioMuted).toBe(false)
    expect(window.mutedValues).toEqual([])
  })

  it('窗口已销毁时不抛，状态照样更新（退出流程里点托盘的那条路）', () => {
    const window = fakeWindow()
    window.isDestroyed = () => true

    expect(() => {
      setAudioMuted(asWindow(window), true)
    }).not.toThrow()
    expect(quietState().audioMuted).toBe(true)
    expect(window.mutedValues).toEqual([])
  })

  it('两个开关各管各的字段，互不牵连', () => {
    const window = fakeWindow()

    setNotificationsMuted(true)
    setAudioMuted(asWindow(window), true)

    const both: QuietState = { audioMuted: true, notificationsMuted: true }
    expect(quietState()).toEqual(both)

    setNotificationsMuted(false)
    expect(quietState()).toEqual({ audioMuted: true, notificationsMuted: false })
  })
})
