/**
 * 主动提示用户的那些消息（`shared/notice.ts`）的判据。
 *
 * 通知这类东西有两种坏法，都不会有人报：
 *
 *   1. **刷屏** —— 一次点击会引发一串事件（PDF 预览文档 + 它加载的 SDK；一次失败的接管会
 *      每点一个文件重演一次），逐条弹通知会让人立刻把通知关掉，那之后真正需要它的提示也看不到了；
 *   2. **从不出现** —— 判据写死（只在启动后第一次、或每种原因永久沉默），后来遇到的人永远
 *      看不到该怎么做。
 *
 * 因此这里把两条规则都钉住。文案只断言"它给出了下一步动作"，不去逐字对齐 —— 逐字对齐只会让
 * 改措辞变成一次测试失败。
 */

import { describe, expect, it } from 'vitest'

import {
  CAPTURE_FAILED_TITLE,
  PREVIEW_BLOCKED_BODY,
  PREVIEW_BLOCKED_TITLE,
  PREVIEW_NOTICE_COOLDOWN_MS,
  captureFailureBody,
  shouldAnnouncePreviewBlocked,
  trackCaptureFailure,
} from '../../src/shared/notice'
import type { CaptureFailure } from '../../src/shared/types'

const NOW = 1_700_000_000_000
const WRITE_FAILED: CaptureFailure = { kind: 'write-failed', reason: 'ENOSPC' }
const TOO_LARGE: CaptureFailure = { kind: 'too-large', bytes: 5 * 1024 * 1024 * 1024 }

describe('接管失效的提示簿记（trackCaptureFailure）', () => {
  it('从没提示过的原因要提示', () => {
    expect(trackCaptureFailure(new Set(), WRITE_FAILED)).toEqual({
      announce: true,
      announced: new Set(['write-failed']),
    })
  })

  it('同一种原因不再重复（磁盘满时每点一个文件都会失败一次）', () => {
    const first = trackCaptureFailure(new Set(), WRITE_FAILED)

    expect(trackCaptureFailure(first.announced, WRITE_FAILED).announce).toBe(false)
  })

  it('换了一种原因仍然提示（那正是要让人看见的）', () => {
    const first = trackCaptureFailure(new Set(), WRITE_FAILED)

    expect(trackCaptureFailure(first.announced, TOO_LARGE).announce).toBe(true)
  })

  it('接管恢复正常后重新武装（同一个原因第二次出现仍会说话）', () => {
    const failed = trackCaptureFailure(new Set(), WRITE_FAILED)
    const healthy = trackCaptureFailure(failed.announced, null)

    expect(healthy.announced.size).toBe(0)
    expect(trackCaptureFailure(healthy.announced, WRITE_FAILED).announce).toBe(true)
  })
})

describe('失效提示的内容', () => {
  it('正文是人话，且与界面共用同一份说明（不出现"日志说 A、通知说 B"）', () => {
    expect(CAPTURE_FAILED_TITLE).not.toBe('')
    // `describeCaptureFailure()` 的输出本身就是一句可独立阅读的话。
    expect(captureFailureBody(WRITE_FAILED)).toContain('ENOSPC')
    expect(captureFailureBody(TOO_LARGE)).toContain('上限')
  })
})

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

describe('预览被挡下时的提示内容', () => {
  it('给出下一步动作（含「下载」），而不只是解释一件事', () => {
    expect(PREVIEW_BLOCKED_TITLE).not.toBe('')
    expect(PREVIEW_BLOCKED_BODY).toContain('下载')
    // 也不能只说"下载"：用户要知道下载之后会发生什么，否则他会怀疑文件去哪了。
    expect(PREVIEW_BLOCKED_BODY).toContain('文件列表')
  })
})
