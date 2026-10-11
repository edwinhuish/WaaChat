/**
 * 「哪些改动还在等重启」的单测（`src/shared/types.ts` 的 `changedRestartKeys`）。
 *
 * 为什么值得测：这是「立即重启」按钮**唯一**的显示判据（[ADR-0064]），而它判错的两个方向
 * 都不会报错 ——
 *
 *   - 多显示一次：一颗"按下去整个应用重启"的按钮出现在没有任何待生效改动的时候，既是噪音
 *     也让真的改过的那一次失去信号；
 *   - 少显示一次：用户以为那一项已经生效了，而它要等到下次自己重启才生效 ——
 *     [ADR-0063] 的"改了没反应"正是这么来的。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SETTINGS,
  RESTART_REQUIRED_SETTINGS,
  changedRestartKeys,
  type Settings,
} from '../../src/shared/types'

const withUiLanguage = (code: string): Settings => ({ ...DEFAULT_SETTINGS, uiLanguage: code })

describe('changedRestartKeys', () => {
  it('什么都没改 ⇒ 没有待重启的项', () => {
    expect(changedRestartKeys(DEFAULT_SETTINGS, DEFAULT_SETTINGS)).toEqual([])
  })

  it('界面语言改过 ⇒ 它是待重启项', () => {
    expect(changedRestartKeys(DEFAULT_SETTINGS, withUiLanguage('es-ES'))).toEqual(['uiLanguage'])
  })

  it('基准是**进程启动时**的值：改走再改回来就不再待重启（与界面所见一致）', () => {
    const startup = DEFAULT_SETTINGS

    expect(changedRestartKeys(startup, withUiLanguage('es-ES'))).toEqual(['uiLanguage'])
    expect(changedRestartKeys(startup, withUiLanguage(startup.uiLanguage))).toEqual([])
  })

  it('**不需要**重启的项改了不算（否则按钮会为无关的改动冒出来）', () => {
    const changed: Settings = {
      ...DEFAULT_SETTINGS,
      openOnCapture: !DEFAULT_SETTINGS.openOnCapture,
      spellcheckLanguages: 'de',
      cacheMaxBytes: 1,
    }

    expect(changedRestartKeys(DEFAULT_SETTINGS, changed)).toEqual([])
  })

  it('只挑"在名单里、且真的变了"的键 —— 名单将来变长时这条自动跟着走', () => {
    const changed: Settings = { ...withUiLanguage('ja-JP'), openOnCapture: false }
    const pending = changedRestartKeys(DEFAULT_SETTINGS, changed)

    expect(pending).toEqual(
      RESTART_REQUIRED_SETTINGS.filter((key) => DEFAULT_SETTINGS[key] !== changed[key]),
    )
    expect(pending).toEqual(['uiLanguage'])
  })
})
