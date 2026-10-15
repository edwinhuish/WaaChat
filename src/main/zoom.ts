/**
 * 应用菜单里的缩放动作（「放大」/「缩小」/「实际大小」，[ADR-0079]）。
 *
 * 为什么需要这一层：缩放有**两个入口** —— 设置页那个下拉框（走 `settings:set`，返回值里就是
 * 新设置）和菜单里的三项（不经过界面）。后者必须自己把"改了什么、要让谁跟上、界面怎么知道"
 * 走完，否则会出现两种坏结果：只有一部分窗口缩放了，或者设置页显示着一个陈旧的值。
 *
 * 判据（档位、上下界、百分比文案）全在 `shared/zoom.ts`；这里只负责"读当前值 → 算下一档 →
 * 落盘 → 让窗口跟上 → 通知设置窗口"这条链。
 */

import { DEFAULT_ZOOM_FACTOR, formatZoomPercent, zoomStepDown, zoomStepUp } from '../shared/zoom'
import { logger } from './logger'
import { getSettings, updateSettings } from './settings'
import { applyZoomToAllWindows, pushSettingsToSettingsWindow } from './window'

/** 走一档。`1` = 放大，`-1` = 缩小。 */
export function stepZoom(direction: 1 | -1): void {
  const current = getSettings().zoomFactor
  applyZoom(direction === 1 ? zoomStepUp(current) : zoomStepDown(current))
}

/** 「实际大小」：回到 100%。 */
export function resetZoom(): void {
  applyZoom(DEFAULT_ZOOM_FACTOR)
}

/**
 * 落盘并让三扇窗口跟上。
 *
 * ⚠️ **到顶 / 到底时什么都不做**（直接 `return`）：那一次"菜单点了一下"没有任何效果，因此既不
 * 该写一次设置文件，也不该推一条通知 —— 否则用户在顶端连按十次放大，磁盘就被写十次，设置窗口
 * 也被重画十次。判据放在这里而不是菜单项里（菜单项没有"当前值"这个概念）。
 */
function applyZoom(factor: number): void {
  if (factor === getSettings().zoomFactor) return

  const next = updateSettings({ zoomFactor: factor })

  applyZoomToAllWindows()
  pushSettingsToSettingsWindow(next)

  logger.info('zoom changed from the menu', { percent: formatZoomPercent(factor) })
}
