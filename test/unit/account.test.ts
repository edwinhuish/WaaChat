/**
 * 账号标识解析的单测（[ADR-0039]）。
 *
 * 这一层只做两件事：**认出一个 WID、以及在 Local Storage 的字节里找到它**。两件都属于
 * "错了就静默错到底"的那一类：
 *
 *   - WID 认宽了 → 可能把别的东西当账号（把文件归到陌生名字下）；
 *   - 认窄了 → 永远退到 cookie / 回落值，目录名对人不友好（但不丢数据）。
 *
 * 因此这里全部用**合成的字节**，不碰开发者本机真实的 `~/.config/waachat`。
 */

import { describe, expect, it } from 'vitest'

import {
  WID_STORAGE_KEYS,
  accountKeyFromText,
  extractAccountKeyFromBytes,
  pickAccountKey,
} from '../../src/main/account'

/** 一个典型的 WID：`<数字>[:<设备>]@<域>`。 */
const WID = '18665597400:12@c.us'

/** 把键值按 Chromium 的两种编码之一拼成一段字节。 */
function storageBytes(key: string, value: string, encoding: 'utf16le' | 'latin1'): Uint8Array {
  return Buffer.from(`${key}\u0000${value}`, encoding)
}

describe('accountKeyFromText', () => {
  it('认得出 WID，并取数字那一段（目录名就是它）', () => {
    expect(accountKeyFromText(WID)).toBe('18665597400')
    expect(accountKeyFromText('18665597400@c.us')).toBe('18665597400')
    expect(accountKeyFromText('123456789012345@s.whatsapp.net')).toBe('123456789012345')
    expect(accountKeyFromText('123456789012345@lid')).toBe('123456789012345')
  })

  it('周围有别的字节也能认出来（LevelDB 里键值相邻，片段不干净）', () => {
    expect(accountKeyFromText(`\u0000\u0001${WID}\u0000junk`)).toBe('18665597400')
  })

  it('不是 WID 的一律不认', () => {
    expect(accountKeyFromText('')).toBeNull()
    expect(accountKeyFromText('not a wid')).toBeNull()
    expect(accountKeyFromText('123@c.us')).toBeNull() // 太短：那不像一个号码
    expect(accountKeyFromText('18665597400000000000@c.us')).toBeNull() // 太长
    expect(accountKeyFromText('18665597400@example.com')).toBeNull()
    expect(accountKeyFromText('18665597400:99999@c.us')).toBeNull() // 设备号不该有五位
  })
})

describe('extractAccountKeyFromBytes', () => {
  it('UTF-16LE 的值能取到', () => {
    expect(extractAccountKeyFromBytes(storageBytes('last-wid', WID, 'utf16le'))).toBe('18665597400')
  })

  it('Latin-1（或者说 UTF-8 的 ASCII 部分）的值也能取到', () => {
    expect(extractAccountKeyFromBytes(storageBytes('last-wid-md', WID, 'latin1'))).toBe(
      '18665597400',
    )
  })

  it('两个键名都认（上游在不同版本里换过名字）', () => {
    for (const key of WID_STORAGE_KEYS) {
      expect(extractAccountKeyFromBytes(storageBytes(key, WID, 'latin1'))).toBe('18665597400')
    }
  })

  it('同一个文件里取最后一个（WAL 追加写，越靠后越新）', () => {
    const bytes = Buffer.from(
      `last-wid\u000018000000000:1@c.us\u0000last-wid\u000018665597400:12@c.us`,
      'latin1',
    )

    expect(extractAccountKeyFromBytes(bytes)).toBe('18665597400')
  })

  it('只有键名、值不是 WID 时返回 null（退到下一级，而不是猜）', () => {
    expect(extractAccountKeyFromBytes(storageBytes('last-wid', 'garbage', 'latin1'))).toBeNull()
    expect(extractAccountKeyFromBytes(Buffer.from('nothing here', 'latin1'))).toBeNull()
    expect(extractAccountKeyFromBytes(new Uint8Array(0))).toBeNull()
  })
})

describe('pickAccountKey', () => {
  it('取第一个非空值（列表顺序就是优先级）', () => {
    expect(pickAccountKey(['', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'])).toBe(
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    )
    expect(pickAccountKey(['', '   '])).toBeNull()
    expect(pickAccountKey([])).toBeNull()
  })
})
