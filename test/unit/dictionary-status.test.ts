/**
 * 词典下载状态的单测（`src/shared/dictionary-status.ts`，[ADR-0071]）。
 *
 * 为什么值得测：这张状态机的**输入是内核发来的四个事件**，而它出错的方式全是安静的 ——
 * 映射写反了，症状是"设置里那一格停在未开始"或"蓝条先亮后灭"，两者都与"功能正常"长得一样。
 * 因此这里断言的是**每一条路径**，而不是某一次调用的结果。
 */

import { describe, expect, it } from 'vitest'

import {
  dictionaryKey,
  dictionaryRetryDelay,
  languagesWithoutStatus,
  nextDictionaryStatus,
  type DictionaryEvent,
  type DictionaryStatus,
} from '../../src/shared/dictionary-status'

const EVENTS: readonly DictionaryEvent[] = [
  'queued',
  'download-begin',
  'download-success',
  'download-failure',
  'initialized',
]

describe('nextDictionaryStatus', () => {
  it('下载开始 → 下载中（从"没听到过"与从"失败"都一样）', () => {
    expect(nextDictionaryStatus(undefined, 'download-begin')).toBe('downloading')
    expect(nextDictionaryStatus('unknown', 'download-begin')).toBe('downloading')
    // 内核在成功之前会**反复重试**：失败过不该让之后的尝试不再显示。
    expect(nextDictionaryStatus('failed', 'download-begin')).toBe('downloading')
  })

  it('交给内核 → 等待中（只从"没有消息"推进，绝不把别的状态往回拉）', () => {
    expect(nextDictionaryStatus(undefined, 'queued')).toBe('pending')
    expect(nextDictionaryStatus('unknown', 'queued')).toBe('pending')
    expect(nextDictionaryStatus('pending', 'queued')).toBe('pending')

    // 关键的一条：每次改设置／界面语言变化都会重跑 `applySpellcheck()`，它**不能**让那条正在
    // 走的扫动条闪回"等待中"，也不能把一次失败画成"还在等"（再设一遍同一个列表是 no-op）。
    expect(nextDictionaryStatus('downloading', 'queued')).toBe('downloading')
    expect(nextDictionaryStatus('failed', 'queued')).toBe('failed')
    expect(nextDictionaryStatus('ready', 'queued')).toBe('ready')
  })

  it('等待中之后的那三条消息各自落位', () => {
    expect(nextDictionaryStatus('pending', 'download-begin')).toBe('downloading')
    expect(nextDictionaryStatus('pending', 'download-success')).toBe('ready')
    expect(nextDictionaryStatus('pending', 'initialized')).toBe('ready')
    expect(nextDictionaryStatus('pending', 'download-failure')).toBe('failed')
  })

  it('拿到字节与装载完成都是"就绪"（磁盘上本来就有词典时只有后一个事件）', () => {
    expect(nextDictionaryStatus(undefined, 'download-success')).toBe('ready')
    expect(nextDictionaryStatus('downloading', 'download-success')).toBe('ready')
    expect(nextDictionaryStatus(undefined, 'initialized')).toBe('ready')
    expect(nextDictionaryStatus('downloading', 'initialized')).toBe('ready')
  })

  it('下载失败 → 失败', () => {
    expect(nextDictionaryStatus(undefined, 'download-failure')).toBe('failed')
    expect(nextDictionaryStatus('downloading', 'download-failure')).toBe('failed')
    expect(nextDictionaryStatus('failed', 'download-failure')).toBe('failed')
  })

  it('就绪是终局：文件已经在磁盘上，后面任何消息都不该把蓝条改回别的样子', () => {
    for (const event of EVENTS.filter((item) => item !== 'download-begin')) {
      expect(nextDictionaryStatus('ready', event)).toBe('ready')
    }
  })

  it('从"就绪"再收到下载开始 → 重新回到下载中（用户可能是把那门删了又加回来）', () => {
    expect(nextDictionaryStatus('ready', 'download-begin')).toBe('downloading')
  })

  it('每一种状态 × 每一个事件都有定义（没有落空的组合）', () => {
    const states: readonly DictionaryStatus[] = [
      'unknown',
      'pending',
      'downloading',
      'ready',
      'failed',
    ]

    for (const state of states) {
      for (const event of EVENTS) {
        expect(['unknown', 'pending', 'downloading', 'ready', 'failed']).toContain(
          nextDictionaryStatus(state, event),
        )
      }
    }
  })
})

describe('dictionaryRetryDelay', () => {
  it('第一次重试快、第二次慢', () => {
    expect(dictionaryRetryDelay(1)).toBe(5000)
    expect(dictionaryRetryDelay(2)).toBe(30_000)
  })

  it('之后**放弃**（返回 null，而不是一个极大的延时 —— 放弃了就要留一条日志）', () => {
    expect(dictionaryRetryDelay(3)).toBeNull()
    expect(dictionaryRetryDelay(99)).toBeNull()
  })

  it('退避是递增的（不该越重试越急）', () => {
    const first = dictionaryRetryDelay(1)
    const second = dictionaryRetryDelay(2)

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second ?? 0).toBeGreaterThan(first ?? 0)
  })
})

describe('dictionaryKey', () => {
  it('大小写归一：事件里的码与设置里的码不必逐字节相同', () => {
    expect(dictionaryKey('en-US')).toBe('en-us')
    expect(dictionaryKey('EN-us')).toBe(dictionaryKey('en-US'))
  })

  it('已经是小写的码原样返回（`de` / `fr` / `ko` 这类不变的码不受影响）', () => {
    expect(dictionaryKey('de')).toBe('de')
    expect(dictionaryKey('pt-br')).toBe('pt-br')
  })
})

/**
 * 启动时那次"兜底重播"的判据（[ADR-0073]）。
 *
 * 为什么值得测：它决定**要不要**对整组语言重播一次，而重播的杠杆是"清空再设回"。判据写松了会
 * 把正在下载的那几门打断（清空整组时它们的下载一起没了）；写紧了则救不回"漏听"的那几格 ——
 * 两种错法都只表现成"那一格颜色不对"，不会报错。
 */
describe('languagesWithoutStatus', () => {
  it('一条消息都没听到的语言才算"缺状态"', () => {
    expect(languagesWithoutStatus(['en-US', 'es'], {})).toEqual(['en-US', 'es'])
  })

  it('已经听到消息的（下载中 / 就绪 / 失败）都不算缺 —— 对这些重播会打断正在进行的下载', () => {
    expect(
      languagesWithoutStatus(['en-US', 'es', 'de'], {
        'en-us': 'ready',
        es: 'downloading',
        de: 'failed',
      }),
    ).toEqual([])
  })

  it('`pending` 算"缺"：它只说明我们交上去了，内核一个字的回音都还没有（[ADR-0091]）', () => {
    // 若是反过来（把 pending 当作"听到过"），这道兜底会**整条失效**：启动时
    // `applySpellcheck()` 刚把语言交上去，每一门都正好是 pending。
    expect(languagesWithoutStatus(['en-US'], { 'en-us': 'pending' })).toEqual(['en-US'])
    expect(languagesWithoutStatus(['en-US', 'es'], { 'en-us': 'pending', es: 'ready' })).toEqual([
      'en-US',
    ])
  })

  it('只挑出缺的那几个，且保持传入的次序', () => {
    expect(languagesWithoutStatus(['de', 'en-US', 'fr'], { 'en-us': 'ready' })).toEqual([
      'de',
      'fr',
    ])
  })

  it('查表用的是归一之后的键：传进来的语言码换个大小写也认得出来', () => {
    expect(languagesWithoutStatus(['EN-us'], { 'en-us': 'ready' })).toEqual([])
  })

  it('状态表那一侧的键假定**已经**归一（写入方每次都过 `dictionaryKey()`）', () => {
    // 这一条钉的是"两份字符串必须经过同一个归一"这件事：表里若留着没归一的形状（`EN-US`），
    // 查 `en-US` 就会落空。写入方（`main/spellcheck.ts`）全部经过 `dictionaryKey()`，
    // 因此这不是一条缺陷，而是一条**前提** —— 谁绕过它谁就会让那一格永远停在空槽。
    expect(languagesWithoutStatus(['en-US'], { 'EN-US': 'ready' })).toEqual(['en-US'])
  })

  it('空列表不炸（内核还没给出清单时调用方会在更早的地方早退）', () => {
    expect(languagesWithoutStatus([], {})).toEqual([])
  })
})
