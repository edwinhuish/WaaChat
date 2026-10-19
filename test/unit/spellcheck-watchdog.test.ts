/**
 * 词典下载看门狗的单测（[ADR-0091]）。
 *
 * 为什么值得测：它盯的是**最安静**的那种失败 —— 内核既不回"开始下载"也不回"失败"，那条请求
 * 像 [ADR-0068] 实测的那样停在半路。此时界面上只有一条永远不动的"等待中"，输入框里一条红线
 * 都没有，日志里也什么都没有。因此这里断言两件事：**它会不会自己再要一次**，以及**要几次之后
 * 认栽**（认栽之后界面才红得起来，而"一直在等"没有任何出路）。
 *
 * 本文件 import 的是主进程模块，但它对 electron 只有 `import type` —— 前提见
 * `src/main/spellcheck.ts` 文件头，也是 `ai/CONVENTIONS.md` 第 8 节"单测不加载 Electron"。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applySpellcheck,
  dictionaryStatusSnapshot,
  watchSpellcheck,
} from '../../src/main/spellcheck'
import type { Session } from 'electron'

import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/types'

/**
 * 一份只够跑通 `applySpellcheck()` 的假会话。
 *
 * 只实现本模块真的会碰的那四个成员：读到"内核支持哪些语言"、开关检查器、交语言、写下载源。
 */
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

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('词典下载看门狗', () => {
  it('内核一直不说话：8 秒 / 30 秒各再要一次，一分钟后再没动静就记成失败', () => {
    const { session, setLanguages } = fakeSession(['en-US'])
    watchSpellcheck(
      session,
      () => settingsWith('en-US'),
      () => {},
    )

    applySpellcheck(session, settingsWith('en-US'))
    expect(setLanguages).toHaveBeenCalledTimes(1)
    // 交上去之后先进"等待中"—— 它与被选中的其余几门（没有键）靠这一条分开。
    expect(dictionaryStatusSnapshot()['en-us']).toBe('pending')

    // 第一次回头看：还是没动静 → 清空 + 设回（唯一有效的杠杆，见 ADR-0072）。
    vi.advanceTimersByTime(8_000)
    expect(setLanguages).toHaveBeenCalledTimes(3)
    expect(setLanguages).toHaveBeenLastCalledWith(['en-US'])
    expect(dictionaryStatusSnapshot()['en-us']).toBe('pending')

    vi.advanceTimersByTime(30_000)
    expect(setLanguages).toHaveBeenCalledTimes(5)

    // 最后一次机会走完，记成失败：界面上红得起来，用户能重试。
    vi.advanceTimersByTime(60_000)
    expect(setLanguages).toHaveBeenCalledTimes(5)
    expect(dictionaryStatusSnapshot()['en-us']).toBe('failed')
  })

  it('内核已经有回音（开始下载）时不再打扰它 —— 重试会把那条下载打断', () => {
    const { session, setLanguages, emit } = fakeSession(['de'])
    watchSpellcheck(
      session,
      () => settingsWith('de'),
      () => {},
    )

    applySpellcheck(session, settingsWith('de'))
    expect(dictionaryStatusSnapshot().de).toBe('pending')

    emit('spellcheck-dictionary-download-begin', 'de')
    expect(dictionaryStatusSnapshot().de).toBe('downloading')

    // 8 + 30 + 60 秒全走完：一个补丁都不该发出去。
    vi.advanceTimersByTime(98_000)
    expect(setLanguages).toHaveBeenCalledTimes(1)
    expect(dictionaryStatusSnapshot().de).toBe('downloading')
  })
})
