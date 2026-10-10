/**
 * 主动提示用户的那些消息（`shared/notice.ts`）的判据。
 *
 * 通知这类东西有两种坏法，都不会有人报：
 *
 *   1. **刷屏** —— 一次失败的接管会每点一个文件重演一次，逐条弹通知会让人立刻把通知关掉，
 *      那之后真正需要它的提示也看不到了；
 *   2. **从不出现** —— 判据写死（只在启动后第一次、或每种原因永久沉默），后来遇到的人永远
 *      看不到该怎么做。
 *
 * 因此这里把两条规则都钉住。文案只断言"它给出了下一步动作"，不去逐字对齐 —— 逐字对齐只会让
 * 改措辞变成一次测试失败。
 */

import { describe, expect, it } from 'vitest'

import {
  CAPTURE_FAILED_TITLE,
  captureFailureBody,
  trackCaptureFailure,
} from '../../src/shared/notice'
import type { CaptureFailure } from '../../src/shared/types'

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
