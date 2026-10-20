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
  FULLSCREEN_HINT_BODY,
  FULLSCREEN_HINT_TITLE,
  NEW_MESSAGES_TITLE,
  SPELLCHECK_DICTIONARY_FAILED_TITLE,
  captureFailureBody,
  newMessagesBody,
  shouldAnnounceNewMessages,
  spellcheckDictionaryFailureBody,
  trackCaptureFailure,
  trackDictionaryFailure,
  trackFullscreenHint,
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

describe('拼写词典下载失败的提示簿记（trackDictionaryFailure）', () => {
  it('从没提示过的语言要提示', () => {
    expect(trackDictionaryFailure(new Set(), 'en-US')).toEqual({
      announce: true,
      announced: new Set(['en-US']),
    })
  })

  it('同一门词典不再重复（内核会在每次输入时重试下载）', () => {
    const first = trackDictionaryFailure(new Set(), 'en-US')

    expect(trackDictionaryFailure(first.announced, 'en-US').announce).toBe(false)
  })

  it('另一门词典仍然提示（勾了多门时，一门下不下来不该让别的沉默）', () => {
    const first = trackDictionaryFailure(new Set(), 'en-US')

    expect(trackDictionaryFailure(first.announced, 'fr').announce).toBe(true)
  })
})

describe('词典下载失败的内容', () => {
  it('正文说出是哪一门词典，并给出下一步动作', () => {
    expect(SPELLCHECK_DICTIONARY_FAILED_TITLE).not.toBe('')
    expect(spellcheckDictionaryFailureBody('en-US')).toContain('en-US')
    expect(spellcheckDictionaryFailureBody('en-US')).toContain('设置')
  })
})

describe('全屏提示的簿记（trackFullscreenHint）', () => {
  it('第一次进入全屏要提示', () => {
    expect(trackFullscreenHint(false)).toEqual({ announce: true, announced: true })
  })

  it('之后不再提示（点开一张图也会进全屏，每次都说会把通知吵到被关掉）', () => {
    const first = trackFullscreenHint(false)

    expect(trackFullscreenHint(first.announced).announce).toBe(false)
  })
})

describe('全屏提示的内容', () => {
  it('给出唯一那个键：Esc', () => {
    expect(FULLSCREEN_HINT_TITLE).not.toBe('')
    expect(FULLSCREEN_HINT_BODY).toContain('Esc')
  })

  it('**不**把 F11 写进去 —— 它是我们自己的「窗口全屏」，退不出页面的 HTML 全屏', () => {
    // 写进去的后果是用户按了没用，然后连这条提示一起不信。
    expect(FULLSCREEN_HINT_BODY).not.toContain('F11')
  })
})

describe('新消息提示的判据（shouldAnnounceNewMessages）', () => {
  /** 窗口在后台、未读从 5 涨到 6 —— 最典型的那一次。 */
  const behind = { foreground: false }

  it('未读上升且窗口不在前台：提示', () => {
    expect(shouldAnnounceNewMessages({ ...behind, previous: 5, current: 6 })).toBe(true)
  })

  it('窗口在前台：不提示（用户自己看得见，再弹一次是重复）', () => {
    expect(shouldAnnounceNewMessages({ foreground: true, previous: 5, current: 6 })).toBe(false)
  })

  it('计数没变：不提示（标题会被切会话与上游定时器频繁重写）', () => {
    expect(shouldAnnounceNewMessages({ ...behind, previous: 5, current: 5 })).toBe(false)
  })

  it('读掉几条（5 → 3）：不提示', () => {
    expect(shouldAnnounceNewMessages({ ...behind, previous: 5, current: 3 })).toBe(false)
  })

  it('读完清零（5 → null）：不提示', () => {
    expect(shouldAnnounceNewMessages({ ...behind, previous: 5, current: null })).toBe(false)
  })

  it('读完又来一条（null → 1）：**要**提示 —— null 是"没有已知未读"，不是"不知道"', () => {
    // 这一条是最容易写错的那个边界：把 null 当成"未知"而跳过，读完消息之后的第一次提示
    // 就会永久沉默（直到重启）。
    expect(shouldAnnounceNewMessages({ ...behind, previous: null, current: 1 })).toBe(true)
  })

  it('启动时页面报上来的历史未读（首次读数、窗口可见）：不提示', () => {
    // `previous: null` + 窗口在前台，正是"昨天没读完的 5 条被页面报上来"那一刻。
    expect(shouldAnnounceNewMessages({ foreground: true, previous: null, current: 5 })).toBe(false)
  })

  it('启动时窗口就是隐藏的（托盘常驻自启）：提示 —— 那时它确实该出现', () => {
    expect(shouldAnnounceNewMessages({ ...behind, previous: null, current: 5 })).toBe(true)
  })

  it('current 为 null（标题里没有未读前缀）：不提示', () => {
    expect(shouldAnnounceNewMessages({ ...behind, previous: null, current: null })).toBe(false)
  })
})

describe('新消息提示的内容', () => {
  it('标题与正文都非空，正文说出总数', () => {
    expect(NEW_MESSAGES_TITLE).not.toBe('')
    expect(newMessagesBody(7)).toContain('7')
  })

  it('正文把那个数字说成**未读总数**，而不是"又来了 N 条"', () => {
    // 页面标题里的数字是未读总数（5 → 6 是"现在 6 条"，不是"刚来 1 条"）。
    // 写成增量会让用户以为丢了消息。
    expect(newMessagesBody(6)).not.toContain('又')
  })
})
