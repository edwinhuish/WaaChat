/**
 * H1（`src/main/capture/early-identity.ts`）的单测。
 *
 * 这一层决定**打开哪一个本地文件**，因此它的失败模式不是"没生效"而是"开错了文件"。
 * 三条不能靠人记住的性质，用测试钉住：
 *
 *   1. **严格解码**：只接受"恰好 32 字节"的 base64，畸形输入一律不认（`Buffer.from` 会
 *      宽松地忽略多余字符，光看长度不够）。
 *   2. **唯一才用**：候选多于一个就放弃 —— 宁可漏命中，不可错命中。
 *   3. **有文件名时不许退回"按大小猜"**：那会把用户开到同名不匹配的另一份文件上。
 *
 * 页面脚本用**假 window 真跑一遍**（`new Function('window', …)`），而不是比对字符串 ——
 * 与本仓库对 `dev-probe-source` 的做法一致。
 */

import { describe, expect, it } from 'vitest'

import {
  decodeFilehash,
  pageLookupExpression,
  pickContentHash,
  pickSingle,
  readPageHashes,
} from '../../src/main/capture/early-identity'

/** 真机实测里 `DZ2602 freight cost.xlsx` 的那一对：base64 与 hex 是同一个值。 */
const REAL_BASE64 = 'sTNpud/Ewu06s8xShz+epGdyp1QxJrPAPuEGJBoZi3c='
const REAL_HEX = 'b13369b9dfc4c2ed3ab3cc52873f9ea46772a7543126b3c03ee106241a198b77'

/** 另一份"合法但不同"的 32 字节摘要（用代码构造，免得手数字符）。 */
const OTHER_BASE64 = Buffer.alloc(32, 1).toString('base64')

interface FakeMessage {
  type?: string
  filename?: string
  size?: number
  filehash?: string
  mediaData?: { size?: number; mimetype?: string }
}

/**
 * 造一个"页面"：只给它 `window`。
 *
 * `require` 可以不给 —— 那正是"上游换了位置"时的样子，脚本必须安静地返回空。
 */
function runOnPage(messages: readonly FakeMessage[], name: string, bytes: number): string {
  const target = {
    require: (moduleName: string) =>
      moduleName === 'WAWebCollections' ? { Msg: { getModelsArray: () => messages } } : undefined,
  }

  // 表达式本身是个 IIFE，`new Function` 的函数体只是"求值一条语句"，因此必须显式 `return`。
  return new Function('window', `return ${pageLookupExpression(name, bytes)}`)(target) as string
}

const hashesOf = (raw: string): string[] => readPageHashes(raw)

/**
 * 造一条"文档"消息。
 *
 * ⚠️ **必须带 `mediaData`**：页面脚本（与探针一样）靠它判定"这条消息带媒体"，少了它整条会被
 * 跳过 —— 真实模型上它总是在的。（第一版夹具漏了，于是"匹配得上"的用例全返回空。）
 */
const documentMessage = (filename: string, size: number, filehash: string): FakeMessage => ({
  type: 'document',
  filename,
  size,
  filehash,
  mediaData: { mimetype: 'application/pdf' },
})

describe('H1：filehash → 归档用的 hex', () => {
  it('真机实测的那一对值能还原成同一个 hex', () => {
    expect(decodeFilehash(REAL_BASE64)).toBe(REAL_HEX)
    // 去掉填充也是同一个值（44 ↔ 43 字符都合法）。
    expect(decodeFilehash(REAL_BASE64.replace(/=+$/, ''))).toBe(REAL_HEX)
  })

  it('长度不是 32 字节的一律不认（宽松解码会忽略多余字符，所以不能只看长度）', () => {
    expect(decodeFilehash('A'.repeat(44))).toBeNull() // 44 字符无填充 ⇒ 33 字节
    expect(decodeFilehash(Buffer.alloc(31).toString('base64'))).toBeNull()
    expect(decodeFilehash(Buffer.alloc(33).toString('base64'))).toBeNull()
  })

  it('非字符串、空、URL-safe 变体与畸形填充都不认', () => {
    expect(decodeFilehash(null)).toBeNull()
    expect(decodeFilehash(undefined)).toBeNull()
    expect(decodeFilehash(123)).toBeNull()
    expect(decodeFilehash('   ')).toBeNull()
    expect(decodeFilehash('sTNpud_Ewu06s8xShz-epGdyp1QxJrPAPuEGJBoZi3c=')).toBeNull() // `-`/`_`
    expect(
      decodeFilehash(`${Buffer.alloc(32).toString('base64').replace(/=+$/, '')}===`),
    ).toBeNull()
  })
})

describe('H1：候选只有一个才用', () => {
  it('空、多个不同值 ⇒ null；同一个值重复出现不算多个', () => {
    expect(pickSingle([])).toBeNull()
    expect(pickSingle([null, null])).toBeNull()
    expect(pickSingle(['a'])).toBe('a')
    expect(pickSingle(['a', 'a'])).toBe('a')
    expect(pickSingle([null, 'a'])).toBe('a')
    expect(pickSingle(['a', 'b'])).toBeNull()
  })

  it('页面回复解析失败一律当成"没有"', () => {
    expect(readPageHashes('{ not json')).toEqual([])
    expect(readPageHashes(undefined)).toEqual([])
    expect(readPageHashes('{}')).toEqual([])
    expect(readPageHashes('{"hashes":"x"}')).toEqual([])
    expect(readPageHashes('{"hashes":["a",1,null]}')).toEqual(['a'])
  })

  it('组合入口：合法且唯一才有结果', () => {
    expect(pickContentHash(JSON.stringify({ hashes: [REAL_BASE64] }))).toBe(REAL_HEX)
    expect(pickContentHash(JSON.stringify({ hashes: [REAL_BASE64, REAL_BASE64] }))).toBe(REAL_HEX)
    expect(pickContentHash(JSON.stringify({ hashes: [REAL_BASE64, OTHER_BASE64] }))).toBeNull()
    expect(pickContentHash(JSON.stringify({ hashes: ['not a hash'] }))).toBeNull()
  })
})

describe('H1：页面脚本（真跑一遍）', () => {
  it('文件名 + 字节数都对上时，返回那条消息的 filehash', () => {
    const raw = runOnPage([documentMessage('报告.pdf', 11980, REAL_BASE64)], '报告.pdf', 11980)

    expect(hashesOf(raw)).toEqual([REAL_BASE64])
  })

  it('**有文件名但没匹配上时不许按大小猜** —— 那会开到另一份文件', () => {
    const raw = runOnPage([documentMessage('报告.pdf', 11980, REAL_BASE64)], '别的.pdf', 11980)

    expect(hashesOf(raw)).toEqual([])
  })

  it('没有文件名（图片/视频在模型里没有）时，字节数是唯一线索', () => {
    const messages: FakeMessage[] = [
      { type: 'image', mediaData: { size: 999, mimetype: 'image/jpeg' }, filehash: 'IMG_HASH' },
      documentMessage('a.xlsx', 1, REAL_BASE64),
    ]

    expect(hashesOf(runOnPage(messages, '', 999))).toEqual(['IMG_HASH'])
    // 大小对不上、又没有文件名 ⇒ 空（没有别的线索可用）
    expect(hashesOf(runOnPage(messages, '', 1000))).toEqual([])
    // 连下载大小都拿不到 ⇒ 同样放弃
    expect(hashesOf(runOnPage(messages, '', 0))).toEqual([])
  })

  it('字节数字段取不到（上游改名）时，仍按文件名命中 —— 大小只用来缩范围', () => {
    // 这条消息**没有**任何 size 字段：模拟上游把那个字段改名之后的样子。
    const withoutSize: FakeMessage = {
      type: 'document',
      filename: '报告.pdf',
      filehash: REAL_BASE64,
      mediaData: { mimetype: 'application/pdf' },
    }

    expect(hashesOf(runOnPage([withoutSize], '报告.pdf', 11980))).toEqual([REAL_BASE64])

    // 但同名的那几条给出不同哈希时，仍然放弃 —— 名字一样不代表内容一样。
    const ambiguous: FakeMessage[] = [withoutSize, { ...withoutSize, filehash: OTHER_BASE64 }]

    expect(pickContentHash(runOnPage(ambiguous, '报告.pdf', 11980))).toBeNull()
  })

  it('同一份内容被转发（两条消息、同一个哈希）仍算唯一', () => {
    const messages: FakeMessage[] = [
      documentMessage('报告.pdf', 10, REAL_BASE64),
      documentMessage('报告.pdf', 10, REAL_BASE64),
    ]

    expect(pickContentHash(runOnPage(messages, '报告.pdf', 10))).toBe(REAL_HEX)
  })

  it('两条不同内容撞上同一个名字与大小 ⇒ 放弃（交给调用方回落）', () => {
    const messages: FakeMessage[] = [
      documentMessage('报告.pdf', 10, REAL_BASE64),
      documentMessage('报告.pdf', 10, OTHER_BASE64),
    ]

    expect(pickContentHash(runOnPage(messages, '报告.pdf', 10))).toBeNull()
  })

  it('文件名是不可信输入：带引号与换行也不许拼坏脚本', () => {
    const nasty = 'a"b\n\\c\u2028.pdf'
    const raw = runOnPage([documentMessage(nasty, 7, REAL_BASE64)], nasty, 7)

    expect(hashesOf(raw)).toEqual([REAL_BASE64])
  })

  it('上游换了位置（拿不到消息集合）时安静地返回空，而不是抛错', () => {
    const empty = new Function('window', `return ${pageLookupExpression('x.pdf', 1)}`)({}) as string

    expect(hashesOf(empty)).toEqual([])
  })
})
