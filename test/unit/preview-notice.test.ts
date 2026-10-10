/**
 * 挡住预览时那条用户提示的判据（`shared/preview-notice.ts`）。
 *
 * 通知这种东西有两种坏法，都不会有人报：
 *
 *   1. **刷屏** —— 一次点击 PDF 会引发一串被挡掉的请求（预览文档 + 它加载的 viewer SDK），
 *      逐条弹通知会让人立刻把通知关掉，那之后真正需要它的提示也看不到了；
 *   2. **从不出现** —— 节流写死（比如只在启动后第一次），后来遇到的人永远看不到该怎么做。
 *
 * 因此这里把节流的边界钉住。文案那一半只断言"它给出了下一步动作"（含「下载」），不去逐字对齐
 * —— 逐字对齐只会让改措辞变成一次测试失败。
 */

import { describe, expect, it } from 'vitest'

import {
  PREVIEW_BLOCKED_BODY,
  PREVIEW_BLOCKED_TITLE,
  PREVIEW_NOTICE_COOLDOWN_MS,
  shouldAnnouncePreviewBlocked,
} from '../../src/shared/preview-notice'

const NOW = 1_700_000_000_000

describe('shouldAnnouncePreviewBlocked', () => {
  it('从没提示过就提示', () => {
    expect(shouldAnnouncePreviewBlocked(null, NOW)).toBe(true)
  })

  it('冷却期内不再提示（一次点击会引发一串请求）', () => {
    expect(shouldAnnouncePreviewBlocked(NOW, NOW + 1)).toBe(false)
    expect(shouldAnnouncePreviewBlocked(NOW, NOW + PREVIEW_NOTICE_COOLDOWN_MS - 1)).toBe(false)
  })

  it('冷却期一到就提示（不是"只提示一次"）', () => {
    expect(shouldAnnouncePreviewBlocked(NOW, NOW + PREVIEW_NOTICE_COOLDOWN_MS)).toBe(true)
    expect(shouldAnnouncePreviewBlocked(NOW, NOW + PREVIEW_NOTICE_COOLDOWN_MS * 10)).toBe(true)
  })

  it('时钟回拨按"刚提示过"处理（宁可少弹一次，也不要刷屏）', () => {
    expect(shouldAnnouncePreviewBlocked(NOW, NOW - 60_000)).toBe(false)
  })

  it('冷却时长可注入（判据与常量分开，便于将来调整）', () => {
    expect(shouldAnnouncePreviewBlocked(NOW, NOW + 5_000, 5_000)).toBe(true)
  })
})

describe('提示内容', () => {
  it('给出下一步动作（含「下载」），而不只是解释一件事', () => {
    expect(PREVIEW_BLOCKED_TITLE).not.toBe('')
    expect(PREVIEW_BLOCKED_BODY).toContain('下载')
    // 也不能只说"下载"：用户要知道下载之后会发生什么，否则他会怀疑文件去哪了。
    expect(PREVIEW_BLOCKED_BODY).toContain('文件列表')
  })
})
