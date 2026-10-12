/**
 * 托盘图标 + 未读徽标（`nativeImage` 那一层，[ADR-0080]）。
 *
 * 判据（点阵字模、圆心比例、上限）都在 `shared/tray-badge.ts`；这里只做它做不到的三步：
 * 把底图缩到画布尺寸、拿到原始位图、再把它变回一张 `nativeImage`。
 *
 * ⚠️ **通道序假设。** `nativeImage.toBitmap()` 的格式是"平台相关"的（Electron 文档原话），
 * 而本项目只跑 Linux（`AGENTS.md` 第 "明确不做"），Skia 在那上面的像素序是 **BGRA** ——
 * 因此红色写在 `offset + 2`、蓝色写在 `offset`。假设若不成立，症状**只是颜色不对**
 * （红变蓝、白字仍是白的），位置与文字都不会错；而且 `toBitmap()` / `createFromBitmap()`
 * 是同一平台上的一对，中间不会发生通道错位。
 *
 * ⚠️ 实际像素数由平台与缩放因子决定，因此画布尺寸从**位图长度**反推，而不是假设它等于
 * {@link TRAY_BADGE_CANVAS}（写死的话，拿到 2× 位图时徽标只会画在左上角那一小块里）。
 */

import { nativeImage } from 'electron'
import type { NativeImage } from 'electron'

import { TRAY_BADGE_CANVAS, drawUnreadBadge } from '../../shared/tray-badge'

/**
 * 在应用图标右下角画一个未读徽标。
 *
 * `base` 由调用方给（`integration/appicon.ts` 的 `effectiveAppIcon()`）—— 这里不自己读文件：
 * 图标的来源只能有一处，否则"换图标"就得在各处分别实现一遍。
 */
export function trayIconWithBadge(base: NativeImage, label: string): NativeImage {
  const resized = base.resize({ width: TRAY_BADGE_CANVAS, height: TRAY_BADGE_CANVAS })

  // `toBitmap()` 每次返回一份新的 Buffer（不是与图片共享的内存），因此原地改它是安全的。
  const bitmap = resized.toBitmap()
  const size = Math.round(Math.sqrt(bitmap.length / 4))

  drawUnreadBadge(bitmap, size, label)

  return nativeImage.createFromBitmap(bitmap, { width: size, height: size })
}
