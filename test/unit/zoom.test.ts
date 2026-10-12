/**
 * 界面缩放的判据（`src/shared/zoom.ts`）。
 *
 * 为什么值得测：这一项出错的方式全是**安静**的 ——
 *
 *   - 收敛没做对（`99` 原样落盘）：内核把超范围的值夹到它**自己的**边界，于是界面显示 300%、
 *     实际 500%，而两边都没有报错；
 *   - 档位表里有一个值不合法（`0`、`-1`、`1e9`）：菜单按到它就会把界面变成一个没法用的样子，
 *     而"我按了放大"与"界面坏了"在用户看来是两件事；
 *   - 走一档在边界上原地踏步或越界：菜单里连按放大到最后一下会跳变，或者永远停不下来。
 *
 * 因此这里断言的是**判据本身的性质**（哪些值能留下、档位表是否自洽），而不是某一次菜单点击的
 * 结果。落到窗口上的那一步（`window.ts` / `main/zoom.ts`）由 `scripts/check-capture.ts` 的
 * 「缩放」一节守着 —— 那要读真实文件才说得清。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ZOOM_FACTOR,
  MAX_ZOOM_FACTOR,
  MIN_ZOOM_FACTOR,
  ZOOM_OPTIONS,
  ZOOM_STEPS,
  formatZoomPercent,
  normalizeZoomFactor,
  zoomStepDown,
  zoomStepUp,
} from '../../src/shared/zoom'

describe('normalizeZoomFactor', () => {
  it('合法档位原样返回（收敛不该改动任何一个菜单能走到的值）', () => {
    for (const step of ZOOM_STEPS) expect(normalizeZoomFactor(step)).toBe(step)
  })

  it('不是数就回到默认（设置文件里的 "1.5" / null / 中文都算）', () => {
    for (const value of [
      '1.5',
      '',
      null,
      undefined,
      {},
      [],
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(normalizeZoomFactor(value)).toBe(DEFAULT_ZOOM_FACTOR)
    }
  })

  it('超范围的值夹到边界（内核会把它们夹到**它自己的**边界，那是两边说法不一致）', () => {
    expect(normalizeZoomFactor(99)).toBe(MAX_ZOOM_FACTOR)
    expect(normalizeZoomFactor(0)).toBe(MIN_ZOOM_FACTOR)
    expect(normalizeZoomFactor(-2)).toBe(MIN_ZOOM_FACTOR)
  })

  it('范围之内的怪值吸附到最接近的档位（手改过设置文件的人不会得到一个命中不了的值）', () => {
    expect(normalizeZoomFactor(1.3)).toBe(1.25)
    expect(normalizeZoomFactor(1.02)).toBe(1)
    expect(normalizeZoomFactor(1.45)).toBe(1.5)
  })

  it('平局时取较小的那个（宁可小一点，也不要毫无预告地放大）', () => {
    // 1.25 与 1.5 的中点前后
    expect(normalizeZoomFactor(1.375)).toBe(1.25)
    expect(normalizeZoomFactor(1.376)).toBe(1.5)
  })
})

describe('zoomStepUp / zoomStepDown', () => {
  it('走一档就是相邻的那个档位', () => {
    expect(zoomStepUp(1)).toBe(1.1)
    expect(zoomStepDown(1)).toBe(0.9)
    expect(zoomStepUp(0.9)).toBe(1)
    expect(zoomStepDown(1.1)).toBe(1)
  })

  it('到顶 / 到底就停在原位 —— 调用方靠"没变"判断不该落盘', () => {
    expect(zoomStepUp(MAX_ZOOM_FACTOR)).toBe(MAX_ZOOM_FACTOR)
    expect(zoomStepDown(MIN_ZOOM_FACTOR)).toBe(MIN_ZOOM_FACTOR)
  })

  it('从表外的值出发也不越界（先是收敛，再走一档）', () => {
    expect(zoomStepUp(99)).toBe(MAX_ZOOM_FACTOR)
    expect(zoomStepDown(0)).toBe(MIN_ZOOM_FACTOR)
    expect(zoomStepDown(999)).toBe(2.5)
  })

  it('连续走满一圈能回到原处、且沿途每一步都在表里', () => {
    let up = MIN_ZOOM_FACTOR
    for (let index = 1; index < ZOOM_STEPS.length; index += 1) {
      up = zoomStepUp(up)
      expect(ZOOM_STEPS).toContain(up)
    }
    expect(up).toBe(MAX_ZOOM_FACTOR)

    let down = MAX_ZOOM_FACTOR
    for (let index = 1; index < ZOOM_STEPS.length; index += 1) down = zoomStepDown(down)
    expect(down).toBe(MIN_ZOOM_FACTOR)
  })
})

describe('档位表与设置页的选项', () => {
  it('表是严格升序的、都在范围内、且没有重复（重复会让"走一档"变成原地踏步）', () => {
    // 比"逐个和前一个比"更省事也更严格：排序后原样相等 ⇒ 升序；去重后长度不变 ⇒ 没有重复。
    expect([...ZOOM_STEPS].sort((left, right) => left - right)).toEqual([...ZOOM_STEPS])
    expect(new Set(ZOOM_STEPS).size).toBe(ZOOM_STEPS.length)

    for (const step of ZOOM_STEPS) {
      expect(step).toBeGreaterThanOrEqual(MIN_ZOOM_FACTOR)
      expect(step).toBeLessThanOrEqual(MAX_ZOOM_FACTOR)
    }

    expect(ZOOM_STEPS).toContain(DEFAULT_ZOOM_FACTOR)
  })

  it('选项由档位表派生（两张表的症状是"菜单走到某档、下拉框里没有它"）', () => {
    expect(ZOOM_OPTIONS.map((option) => option.value)).toEqual([...ZOOM_STEPS])
    for (const option of ZOOM_OPTIONS) expect(option.label).toBe(formatZoomPercent(option.value))
  })

  it('百分比文案是整数（0.67 那种浮点误差不该漏到界面上）', () => {
    expect(formatZoomPercent(0.67)).toBe('67%')
    expect(formatZoomPercent(1)).toBe('100%')
    expect(formatZoomPercent(1.25)).toBe('125%')
    for (const option of ZOOM_OPTIONS) expect(option.label).toMatch(/^\d+%$/)
  })
})
