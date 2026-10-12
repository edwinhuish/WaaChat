/**
 * 界面缩放（[ADR-0079]）。
 *
 * 存的是一个**倍数**（`1` = 100%），与内核 `webContents.setZoomFactor()` 同一个单位 ——
 * 不自己发明"第几档"：设置文件是给人看、给人改的（`"zoomFactor": 1.25` 一看就懂，
 * `"zoomLevel": 3` 得回去查表才知道是几倍）。
 *
 * {@link ZOOM_STEPS} 有两个使用者：**应用菜单**里的放大 / 缩小 / 实际大小，与**设置页**那个
 * 下拉框。两者必须共用同一张表 —— 否则菜单走到 110% 时下拉框里没有这一项，它只能显示成表里的
 * 第一项：一个安静的谎（界面说 50%，实际是 110%）。
 *
 * 收敛（{@link normalizeZoomFactor}）与拼写检查的词典清单同一条纪律：范围与档位都在**读取设置的
 * 那一刻**定下来，手改过设置文件的人得到的是"最接近的合法档位"，而不是一个永远命中不了的怪值。
 */

/** 100%。 */
export const DEFAULT_ZOOM_FACTOR = 1

/**
 * 允许的范围。
 *
 * 上下界不是我们发明的：内核自己只认 25%–500%（超出会被它夹到那一端），我们收得更窄一点 ——
 * 50% 以下那个页面已经读不了，300% 以上连输入框都放不下，而"能设出一个没法用的界面"并不是
 * 一种值得提供的自由。
 */
export const MIN_ZOOM_FACTOR = 0.5
export const MAX_ZOOM_FACTOR = 3

/**
 * 档位表（放大 / 缩小一次走一格；设置页的下拉框照它渲染）。
 *
 * 刻意不取内核那套完整的 25/33/50/67/75/80/90/100/110/125/150/175/200/250/300/400/500 ——
 * 十七档里有一半的差别肉眼看不出来，而每一档都要在菜单里能被连续按到。
 */
export const ZOOM_STEPS: readonly number[] = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2, 2.5, 3]

/** 浮点比较的容差：`0.1 + 0.2` 那类误差不该让"上一档"退化成"原地踏步"。 */
const EPSILON = 1e-6

/**
 * 把不可信的值收敛成合法档位（读设置时用）。
 *
 * 两种坏值都要挡住：**不是数**（`"1.5"`、`null`、有人在设置文件里写了中文）与**超出范围**
 * （`99`、`0`、`-2`）。内核会把超出范围的值夹到它自己的边界，于是界面上显示 300%、实际是
 * 500% —— 用户没有任何办法看出哪一边是错的。夹 + 吸附到最近档位之后，界面与内核说的是同一件事。
 */
export function normalizeZoomFactor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_ZOOM_FACTOR
  return nearestStep(clamp(value, MIN_ZOOM_FACTOR, MAX_ZOOM_FACTOR))
}

/** 上一档（已经在顶就停在顶）。 */
export function zoomStepUp(factor: number): number {
  const current = normalizeZoomFactor(factor)
  return ZOOM_STEPS.find((step) => step > current + EPSILON) ?? MAX_ZOOM_FACTOR
}

/** 下一档（已经在底就停在底）。 */
export function zoomStepDown(factor: number): number {
  const current = normalizeZoomFactor(factor)
  const below = ZOOM_STEPS.filter((step) => step < current - EPSILON)
  return below[below.length - 1] ?? MIN_ZOOM_FACTOR
}

/** `1.25` → `'125%'`。界面上只出现百分比：用户不需要知道 `factor` 是什么。 */
export function formatZoomPercent(factor: number): string {
  return `${Math.round(normalizeZoomFactor(factor) * 100)}%`
}

/**
 * 设置页那个下拉框的选项（值 + 文案，只有这一份）。
 *
 * 由 {@link ZOOM_STEPS} **派生**而不是另写一张表：两张表迟早会不一样，而症状是"下拉框里没有
 * 菜单刚走到的那个档位"（界面显示 50%、实际 110%）。
 */
export const ZOOM_OPTIONS: readonly { readonly value: number; readonly label: string }[] =
  ZOOM_STEPS.map((value) => ({ value, label: formatZoomPercent(value) }))

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 最接近的档位；平局时取**较小**的那个（宁可小一点，也不要毫无预告地放大）。 */
function nearestStep(value: number): number {
  return ZOOM_STEPS.reduce((best, step) =>
    Math.abs(step - value) < Math.abs(best - value) - EPSILON ? step : best,
  )
}
