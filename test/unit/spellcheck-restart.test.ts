/**
 * 关掉再打开之后，词典状态能不能重建（[ADR-0091]）。
 *
 * 为什么值得单独一份：状态表是**内存里的一张 Map**，进程一退就没了 —— 于是"重启后显示得对不对"
 * 完全取决于一个问题：内核在这一次启动里还会不会**再**把那几条消息发一遍。实测（本机探针 +
 * 两趟真实应用启动）的答案是会，而且分两种形状：
 *
 *   - 磁盘上已经有那一门 → `session.fromPartition()` 之后 **几毫秒**就发 `initialized`，
 *     早于 `applySpellcheck()`（它前面隔着读 cookie 的那次往返）；
 *   - 磁盘上没有 → 内核在会话被创建时用 profile 里持久化的列表开始取，`download-begin` 在
 *     **几十毫秒**后到（[ADR-0072] 那条"会话一建就取"的时序），之后 `download-success`。
 *
 * 这两个形状分别对应"下载完成"与"未下载/下载中"两种退出时机；而"下载中被杀掉"实测**磁盘上
 * 什么都不留**（内核在内存里缓冲，成功才落盘），所以它的重启与"未下载"完全同形。
 *
 * 这里把四条路径钉死：它们一旦坏掉，症状都是**安静的** —— 那一格停在"待选"或"等待中"，
 * 与"这门词典本来就不用下载"看不出区别。
 *
 * ⚠️ 每个用例都要 `vi.resetModules()` 重新 import：被测状态是**模块级**的，不重置就等于
 * 没有重启，测的仍是上一个进程。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Session } from 'electron'
import type * as SpellcheckApi from '../../src/main/spellcheck'

import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/types'

type SpellcheckModule = typeof SpellcheckApi

/** 一份只够跑通 `applySpellcheck()` 的假会话（与 `spellcheck-watchdog.test.ts` 同形）。 */
function fakeSession(available: readonly string[]): {
  readonly session: Session
  readonly setLanguages: ReturnType<typeof vi.fn>
  readonly emit: (event: string, language: string) => void
} {
  const handlers = new Map<string, (event: unknown, language: string) => void>()
  const setLanguages = vi.fn()

  const session = {
    availableSpellCheckerLanguages: [...available],
    setSpellCheckerEnabled: vi.fn(),
    setSpellCheckerLanguages: setLanguages,
    setSpellCheckerDictionaryDownloadURL: vi.fn(),
    on: (event: string, handler: (event: unknown, language: string) => void) => {
      handlers.set(event, handler)
      return session
    },
  } as unknown as Session

  return {
    session,
    setLanguages,
    emit: (event, language) => handlers.get(event)?.({}, language),
  }
}

function settingsWith(languages: string): Settings {
  return { ...DEFAULT_SETTINGS, spellcheck: true, spellcheckLanguages: languages }
}

/** 一个"刚起来的进程"：模块级状态全部重新归零。 */
async function freshProcess(): Promise<SpellcheckModule> {
  vi.resetModules()
  return await import('../../src/main/spellcheck')
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('词典状态在重启之后的重建', () => {
  it('「下载完成」那一态退出：内核先发 initialized，随后的 queued 不把它降级', async () => {
    const spellcheck = await freshProcess()
    const { session, emit } = fakeSession(['en-US'])
    spellcheck.watchSpellcheck(
      session,
      () => settingsWith('en-US'),
      () => {},
    )

    // 磁盘上已经有它 —— 内核在 fromPartition() 之后几毫秒就发这一条，早于 applySpellcheck()。
    emit('spellcheck-dictionary-initialized', 'en-US')
    expect(spellcheck.dictionaryStatusSnapshot()['en-us']).toBe('ready')

    // 然后才轮到我们把语言交上去（那一步会记一笔 queued）。
    spellcheck.applySpellcheck(session, settingsWith('en-US'))
    expect(spellcheck.dictionaryStatusSnapshot()['en-us']).toBe('ready')

    // 看门狗到点看到的是"就绪"，不该去打扰它。
    vi.advanceTimersByTime(98_000)
    expect(spellcheck.dictionaryStatusSnapshot()['en-us']).toBe('ready')
  })

  it('「未下载」那一态退出：重启后 pending → downloading → ready，每一步都看得见', async () => {
    const spellcheck = await freshProcess()
    const { session, emit } = fakeSession(['en-US'])
    spellcheck.watchSpellcheck(
      session,
      () => settingsWith('en-US'),
      () => {},
    )

    spellcheck.applySpellcheck(session, settingsWith('en-US'))
    expect(spellcheck.dictionaryStatusSnapshot()['en-US'.toLowerCase()]).toBe('pending')

    emit('spellcheck-dictionary-download-begin', 'en-US')
    expect(spellcheck.dictionaryStatusSnapshot()['en-us']).toBe('downloading')

    emit('spellcheck-dictionary-download-success', 'en-US')
    expect(spellcheck.dictionaryStatusSnapshot()['en-us']).toBe('ready')
  })

  it('「下载中」被杀掉再打开：磁盘上没留下文件，于是与"未下载"完全同形', async () => {
    const spellcheck = await freshProcess()
    const { session, emit } = fakeSession(['es'])
    spellcheck.watchSpellcheck(
      session,
      () => settingsWith('es'),
      () => {},
    )

    // 新进程的表是空的：上一轮的 downloading 不会被记住（实测那次下载在磁盘上什么都不留）。
    expect(spellcheck.dictionaryStatusSnapshot()).toEqual({})

    spellcheck.applySpellcheck(session, settingsWith('es'))
    expect(spellcheck.dictionaryStatusSnapshot().es).toBe('pending')

    // 内核重新取一遍 —— 界面因此重新走一次"下载中"。
    emit('spellcheck-dictionary-download-begin', 'es')
    expect(spellcheck.dictionaryStatusSnapshot().es).toBe('downloading')
  })

  it('漏听了 initialized：兜底重播（清空再设回）能把它救回来，而不是停在"等待中"', async () => {
    const spellcheck = await freshProcess()
    const { session, setLanguages, emit } = fakeSession(['en-US'])
    spellcheck.watchSpellcheck(
      session,
      () => settingsWith('en-US'),
      () => {},
    )

    spellcheck.applySpellcheck(session, settingsWith('en-US'))
    expect(spellcheck.dictionaryStatusSnapshot()['en-us']).toBe('pending')

    // 订阅晚了一步（[ADR-0073]）：该有状态的语言里还有谁没有？pending 也算"还没有"。
    spellcheck.replayMissingDictionaryStatus(session, () => settingsWith('en-US'))
    expect(setLanguages).toHaveBeenCalledWith([])
    expect(setLanguages).toHaveBeenLastCalledWith(['en-US'])

    // 杠杆确实有效（实测：磁盘上已有词典时，清空再设回 **1ms** 就重发 initialized）。
    emit('spellcheck-dictionary-initialized', 'en-US')
    expect(spellcheck.dictionaryStatusSnapshot()['en-us']).toBe('ready')
  })

  it('上一次运行的结论不会跨进程留下来（ready / failed 都不行）', async () => {
    const first = await freshProcess()
    const a = fakeSession(['es'])
    first.watchSpellcheck(
      a.session,
      () => settingsWith('es'),
      () => {},
    )
    first.applySpellcheck(a.session, settingsWith('es'))
    a.emit('spellcheck-dictionary-download-failure', 'es')
    expect(first.dictionaryStatusSnapshot().es).toBe('failed')

    // 第二次启动：状态表必须从空开始 —— 失败与否由这一次的内核重新回答。
    const second = await freshProcess()
    expect(second.dictionaryStatusSnapshot()).toEqual({})
  })
})
