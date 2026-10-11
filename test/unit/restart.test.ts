/**
 * 「哪些改动还在等生效」的单测（`src/shared/types.ts` 的 `changedRestartKeys` 与那张名单）。
 *
 * 为什么值得测：这是条「待生效」提示与「立即重启」那颗按钮**唯一**的显示判据（[ADR-0064]），
 * 而它判错的两个方向都不会报错 ——
 *
 *   - 多显示一次：一条"按下去就重启整个应用"的提示出现在没有任何待生效改动的时候，既是噪音，
 *     也让真的改过的那一次失去信号；
 *   - 少显示一次：用户以为那一项已经生效了，而它要等到下次自己重启才生效。
 *
 * ⚠️ 名单今天是**空的**（[ADR-0066] 撤掉了它唯一待过的成员「界面语言」），因此下面有几条
 * 用例现在是围着一个空集合转的。它们仍然要留着：那一项回来时，这几条就是判据本身 ——
 * 而"名单非空却没人驱动界面"这件事由自检第 19 节挡着（那边断言界面里必须有触发点）。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SETTINGS,
  RESTART_REQUIRED_SETTINGS,
  changedRestartKeys,
  type Settings,
  type SettingsKey,
} from '../../src/shared/types'

/** 改一个**不在名单里**的项（用来验证"无关的改动不产生提示"）。 */
const unrelatedChange: Settings = {
  ...DEFAULT_SETTINGS,
  openOnCapture: !DEFAULT_SETTINGS.openOnCapture,
  spellcheckLanguages: 'de',
  cacheMaxBytes: 1,
}

describe('RESTART_REQUIRED_SETTINGS', () => {
  it('名单里的每一项都是真的设置键（写错一个字母 = 那条判据永远为假）', () => {
    for (const key of RESTART_REQUIRED_SETTINGS) {
      expect(key in DEFAULT_SETTINGS).toBe(true)
    }
  })

  it('今天没有任何项在名单里（界面语言撤掉之后就是这样，[ADR-0066]）', () => {
    // 这条是**真值断言**而不是性质断言：它红了只有两种原因 —— 有人加了需要重启的项（那时
    // 该同时把它接到界面里，见自检第 19 节），或者有人删掉了名单本身。
    expect(RESTART_REQUIRED_SETTINGS).toEqual([])
  })
})

describe('changedRestartKeys', () => {
  it('什么都没改 ⇒ 没有待生效的项', () => {
    expect(changedRestartKeys(DEFAULT_SETTINGS, DEFAULT_SETTINGS)).toEqual([])
  })

  it('**不在名单里**的项改了不算（否则提示会为无关的改动冒出来）', () => {
    expect(changedRestartKeys(DEFAULT_SETTINGS, unrelatedChange)).toEqual([])
  })

  it('只挑"在名单里、且真的变了"的键 —— 名单变长时这一条自动跟着走', () => {
    // 名单为空时这条恒为 `[]`，但它的**判据**与名单非空时是同一条：下面这个期望值就是
    // 那句话的形式化写法。加了一项之后它会立刻开始真的比对。
    const pending = changedRestartKeys(DEFAULT_SETTINGS, unrelatedChange)

    expect(pending).toEqual(
      RESTART_REQUIRED_SETTINGS.filter(
        (key: SettingsKey) => DEFAULT_SETTINGS[key] !== unrelatedChange[key],
      ),
    )
  })

  it('基准是**进程启动时**的值：改走再改回来就不再待生效（与界面所见一致）', () => {
    const startup = DEFAULT_SETTINGS
    const changed: Settings = { ...startup, openOnCapture: !startup.openOnCapture }

    expect(changedRestartKeys(startup, changed)).toHaveLength(
      RESTART_REQUIRED_SETTINGS.filter((key) => startup[key] !== changed[key]).length,
    )
    expect(changedRestartKeys(startup, startup)).toEqual([])
  })
})
