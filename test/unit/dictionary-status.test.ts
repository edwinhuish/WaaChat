/**
 * 词典下载状态的单测（`src/shared/dictionary-status.ts`，[ADR-0071]）。
 *
 * 为什么值得测：这张状态机的**输入是内核发来的四个事件**，而它出错的方式全是安静的 ——
 * 映射写反了，症状是"设置里那一格停在未开始"或"绿条先亮后灭"，两者都与"功能正常"长得一样。
 * 因此这里断言的是**每一条路径**，而不是某一次调用的结果。
 */

import { describe, expect, it } from 'vitest'

import {
  dictionaryKey,
  nextDictionaryStatus,
  type DictionaryEvent,
  type DictionaryStatus,
} from '../../src/shared/dictionary-status'

const EVENTS: readonly DictionaryEvent[] = [
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

  it('就绪是终局：文件已经在磁盘上，后面任何消息都不该把绿条改回别的样子', () => {
    for (const event of EVENTS.filter((item) => item !== 'download-begin')) {
      expect(nextDictionaryStatus('ready', event)).toBe('ready')
    }
  })

  it('从"就绪"再收到下载开始 → 重新回到下载中（用户可能是把那门删了又加回来）', () => {
    expect(nextDictionaryStatus('ready', 'download-begin')).toBe('downloading')
  })

  it('每一种状态 × 每一个事件都有定义（没有落空的组合）', () => {
    const states: readonly DictionaryStatus[] = ['unknown', 'downloading', 'ready', 'failed']

    for (const state of states) {
      for (const event of EVENTS) {
        expect(['unknown', 'downloading', 'ready', 'failed']).toContain(
          nextDictionaryStatus(state, event),
        )
      }
    }
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
