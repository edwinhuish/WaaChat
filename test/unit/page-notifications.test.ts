/**
 * 页面通知 API 开关的单测（[ADR-0094]）。
 *
 * 覆盖三件"改坏了不会立刻发现"的事：
 *
 *   1. **默认要真的把它加上** —— 漏掉的症状是"网页版那条『需要开启通知』的提示条又回来了"
 *      （它不报错、不进日志，只在界面上常驻一条用户点不掉的提示）；
 *   2. **用户自己写了就不动** —— 判断必须走 `hasSwitch`：布尔开关不带 `=` 时
 *      `getSwitchValue` 返回空串，与"没写"分不开；
 *   3. **重复调用是幂等的** —— 装配路径多调一次不该追加两个同名开关。
 *
 * 命令行是注入的假对象，因此这里不需要 Electron。
 */

import { describe, expect, it } from 'vitest'

import {
  applyPageNotificationSuppression,
  PAGE_NOTIFICATIONS_SWITCH,
  type CommandLineLike,
} from '../../src/main/page-notifications'

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

describe('applyPageNotificationSuppression', () => {
  it('默认追加那一个开关，并报告动了命令行', () => {
    const cli = fakeCli()

    expect(applyPageNotificationSuppression(cli)).toBe(true)
    expect(cli.appended).toEqual([PAGE_NOTIFICATIONS_SWITCH])
  })

  it('用户自己写了就不再动（布尔开关按存在判断）', () => {
    const cli = fakeCli([PAGE_NOTIFICATIONS_SWITCH])

    expect(applyPageNotificationSuppression(cli)).toBe(false)
    expect(cli.appended).toEqual([])
  })

  it('重复调用幂等：只追加一次', () => {
    const cli = fakeCli()

    expect(applyPageNotificationSuppression(cli)).toBe(true)
    expect(applyPageNotificationSuppression(cli)).toBe(false)
    expect(cli.appended).toEqual([PAGE_NOTIFICATIONS_SWITCH])
  })

  it('开关名与内核里核对过的那个逐字一致（写错＝提示条静默回来）', () => {
    expect(PAGE_NOTIFICATIONS_SWITCH).toBe('disable-notifications')
  })
})
