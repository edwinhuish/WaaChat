/**
 * 主题判据的单测（`src/shared/theme.ts`）。
 *
 * 为什么值得测：这一项出错的方式全是**安静**的 ——
 *
 *   - 存下一个我们不认识的值（有人顺手把设置文件改成 `"主题": "sepia"`）：`nativeTheme`
 *     会把它当成"没有这个值"，界面看起来只是"没反应"；
 *   - 三个取值里少一个：那一个在界面上**无法抵达**，而它照样能被写进配置文件；
 *   - 窗口底色与样式表的 `--bg` 分家：症状是深色桌面上每次启动闪一下白 —— 只在启动的一瞬间
 *     出现，谁都不会把它当 bug 报。
 *
 * 因此这里断言的是**判据本身的性质**（收敛到哪里、取值表完不完整、两种底色是不是两个值），
 * 而不是某一次调用的返回值。落到 Electron 上的那一步（`main/theme.ts`）与窗口底色的字面值由
 * `scripts/check-capture.ts` 的「主题」一节守着 —— 那两处都要读真实文件才说得清。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_THEME,
  THEME_OPTIONS,
  WINDOW_BACKGROUND,
  normalizeTheme,
  windowBackground,
} from '../../src/shared/theme'

describe('normalizeTheme', () => {
  it('三个合法取值原样返回', () => {
    for (const option of THEME_OPTIONS) expect(normalizeTheme(option.value)).toBe(option.value)
  })

  it('认不出的值收敛到默认（跟随系统），而不是让一个不存在的取值走到 nativeTheme', () => {
    // `nativeTheme` 会静默忽略它不认识的字符串，因此"认不出"必须在这里就被拦住。
    for (const value of ['sepia', '', 'DARK', 'Dark', undefined, null, 42, {}, []]) {
      expect(normalizeTheme(value)).toBe(DEFAULT_THEME)
    }
  })

  it('默认是"跟随系统"（在一台已经切到深色的桌面上，纯白窗口是刺眼的）', () => {
    expect(DEFAULT_THEME).toBe('system')
  })
})

describe('THEME_OPTIONS / WINDOW_BACKGROUND', () => {
  it('选项与 nativeTheme 认得的那三个取值一一对应，且不重样', () => {
    const values = THEME_OPTIONS.map((option) => option.value)
    expect([...values].sort()).toEqual(['dark', 'light', 'system'])
    expect(new Set(values).size).toBe(values.length)
  })

  it('每个选项都有中文文案（英文选项名会漏到界面上）', () => {
    for (const option of THEME_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0)
      // 汉字：只有中文文案才允许出现在这一列里。
      expect(option.label).toMatch(/[\u4e00-\u9fff]/u)
    }
  })

  it('两种底色是两个不同的值（相同的话这个常量就没有意义）', () => {
    expect(WINDOW_BACKGROUND.light).not.toBe(WINDOW_BACKGROUND.dark)
    for (const value of Object.values(WINDOW_BACKGROUND)) expect(value).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('windowBackground 按深浅取对应的那一个', () => {
    expect(windowBackground(true)).toBe(WINDOW_BACKGROUND.dark)
    expect(windowBackground(false)).toBe(WINDOW_BACKGROUND.light)
  })
})
