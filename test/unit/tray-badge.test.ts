/**
 * 托盘徽标绘制的单测（`src/shared/tray-badge.ts`）。
 *
 * 为什么值得测：它是整个项目里**唯一**一处手写像素的地方，而且没有"看错了"之外的失败信号 ——
 * 画到画布外面会串到下一行的像素上（图标上出现一条乱码横线），字模错行会让 `3` 看起来像 `8`，
 * 而这些都只在托盘图标那 22px 里出现，谁都不会把它当 bug 报。因此这里断言的是**几何**：
 * 画在哪、有没有越界、认不出的字符会怎样。
 *
 * 颜色通道序（BGRA）不在这里断言：那是 `main/integration/badge.ts` 对平台做的假设，而不是
 * 本模块的判据 —— 这里只认"第 0 字节 = B、第 1 = G、第 2 = R、第 3 = A"。
 */

import { describe, expect, it } from 'vitest'

import { TRAY_BADGE_CANVAS, drawUnreadBadge } from '../../src/shared/tray-badge'

interface Pixel {
  readonly b: number
  readonly g: number
  readonly r: number
  readonly a: number
}

function makeBitmap(size: number): Uint8Array {
  return new Uint8Array(size * size * 4)
}

function pixelAt(bitmap: Uint8Array, size: number, x: number, y: number): Pixel {
  const offset = (y * size + x) * 4
  return {
    b: bitmap[offset] ?? 0,
    g: bitmap[offset + 1] ?? 0,
    r: bitmap[offset + 2] ?? 0,
    a: bitmap[offset + 3] ?? 0,
  }
}

/** 所有被改动过的像素的外接框；一个都没改就返回 `null`。 */
function changedBounds(
  bitmap: Uint8Array,
  size: number,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = size
  let minY = size
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (pixelAt(bitmap, size, x, y).a === 0) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }

  return maxX < 0 ? null : { minX, minY, maxX, maxY }
}

function countWhite(bitmap: Uint8Array, size: number): number {
  let count = 0

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const pixel = pixelAt(bitmap, size, x, y)
      if (pixel.r === 0xff && pixel.g === 0xff && pixel.b === 0xff) count += 1
    }
  }

  return count
}

describe('drawUnreadBadge', () => {
  it('画的是红底白字，而且只画在右下角（左上角一个字节都不动）', () => {
    const size = TRAY_BADGE_CANVAS
    const bitmap = makeBitmap(size)

    drawUnreadBadge(bitmap, size, '3')

    // 左上角是图标自己的地盘：一个字节都不该被碰过。
    expect(pixelAt(bitmap, size, 0, 0).a).toBe(0)
    expect(pixelAt(bitmap, size, 10, 40).a).toBe(0)
    expect(pixelAt(bitmap, size, 40, 10).a).toBe(0)

    // 字是白的（三个通道都是 0xff —— 因此与通道序无关）。
    expect(countWhite(bitmap, size)).toBeGreaterThan(0)
  })

  it('徽标落在画布之内（越界会串到下一行像素：图标上出现一条乱码横线）', () => {
    const size = TRAY_BADGE_CANVAS
    const bitmap = makeBitmap(size)

    drawUnreadBadge(bitmap, size, '99+')

    const bounds = changedBounds(bitmap, size)
    expect(bounds).not.toBeNull()
    // 圆心在 (43, 43)、半径 19 ⇒ 外接框最多到 62，与画布边缘留 2px。
    expect(bounds?.minX).toBeGreaterThanOrEqual(24)
    expect(bounds?.minY).toBeGreaterThanOrEqual(24)
    expect(bounds?.maxX).toBeLessThanOrEqual(62)
    expect(bounds?.maxY).toBeLessThanOrEqual(62)
  })

  it('三个字符也画得下（99+ 与一位数共用同一套同心几何）', () => {
    const size = TRAY_BADGE_CANVAS
    const one = makeBitmap(size)
    const three = makeBitmap(size)

    drawUnreadBadge(one, size, '3')
    drawUnreadBadge(three, size, '99+')

    // 三个字符比一个字符小一号，但两者都落在同一个圆里。
    expect(countWhite(three, size)).toBeGreaterThan(0)
    expect(changedBounds(three, size)?.minX).toBeGreaterThanOrEqual(24)
    // 圆底一样大：红色的面积不该随字符数变化（变化的只有字）。
    expect(changedBounds(three, size)?.maxY).toBe(changedBounds(one, size)?.maxY)
  })

  it('认不出的字符只留下圆底，不抛错（一个画不出来的徽标不该让托盘消失）', () => {
    const size = TRAY_BADGE_CANVAS
    const bitmap = makeBitmap(size)

    expect(() => drawUnreadBadge(bitmap, size, '?')).not.toThrow()
    expect(countWhite(bitmap, size)).toBe(0)
    expect(changedBounds(bitmap, size)).not.toBeNull()
  })

  it('换画布尺寸也是同一个形状（几何按比例算，不是写死的 64）', () => {
    const size = 32
    const bitmap = makeBitmap(size)

    drawUnreadBadge(bitmap, size, '7')

    const bounds = changedBounds(bitmap, size)
    expect(bounds).not.toBeNull()
    expect(bounds?.minX).toBeGreaterThanOrEqual(10)
    expect(bounds?.maxX).toBeLessThan(size)
    expect(pixelAt(bitmap, size, 0, 0).a).toBe(0)
  })

  it('位图比 size² × 4 还小时抛错，而不是越界写进别人的内存', () => {
    expect(() => drawUnreadBadge(new Uint8Array(16), 8, '1')).toThrow()
    expect(() => drawUnreadBadge(new Uint8Array(0), 0, '1')).toThrow()
  })
})
