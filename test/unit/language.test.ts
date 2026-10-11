/**
 * 拼写词典判据表的单测（`src/shared/language.ts`）。
 *
 * 为什么值得测：这张表是「拼写检查」那一项**唯一**的事实来源，而它出错的方式全是安静的 ——
 * 表里写错一个语言码，症状是"勾了却不查"（红波浪线照样出现，只是划分得不对）；写进一个内核
 * 没有的码，那一项永远不生效。因此这里断言的是**表本身的性质**，而不是某一次调用的返回值。
 *
 * 历史：这个文件也测过**界面语言**那张表（`--lang` 的规范化、网页版那条偏好 cookie 的写法）。
 * [ADR-0066] 撤掉那一整项之后，那些用例与被测的代码一起删掉了 —— 实测结论留在
 * `docs/research/lang-preference.md` §4.5，决定留在 ADR 里。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SPELLCHECK_LANGUAGES,
  SPELLCHECK_LANGUAGES,
  formatLanguageList,
  normalizeSpellcheckLanguages,
  parseLanguageList,
  resolveSpellcheckLanguages,
} from '../../src/shared/language'

describe('parseLanguageList / formatLanguageList', () => {
  it('按逗号切分，去空白、去空项、去重且保序', () => {
    expect(parseLanguageList('en-US, de-DE ,,en-US,fr-FR')).toEqual(['en-US', 'de-DE', 'fr-FR'])
  })

  it('空串得到空数组', () => {
    expect(parseLanguageList('')).toEqual([])
    expect(parseLanguageList(' , , ')).toEqual([])
  })

  it('往返一致', () => {
    const value = 'en-US,de-DE'
    expect(formatLanguageList(parseLanguageList(value))).toBe(value)
  })
})

describe('SPELLCHECK_LANGUAGES', () => {
  it('语言码不重复、全是 `xx` 或 `xx-YY` 形状', () => {
    const codes = SPELLCHECK_LANGUAGES.map((entry) => entry.code)
    expect(new Set(codes).size).toBe(codes.length)

    for (const code of codes) {
      expect(code).toMatch(/^[a-z]{2}(-[A-Z]{2})?$/)
    }
  })

  it('统一用基础语言码：区域码只出现在真有区域变体意义的那几门语言上', () => {
    // ⚠️ 这是**我们的取舍**，不是内核的限制：实测 Electron 44.7 的清单（57 门）里
    // `de` 与 `de-DE`、`fr` 与 `fr-FR`、`it` 与 `it-IT`、`es` 与 `es-ES` **都在**。
    // 仍然写基础码，是因为两者等效而基础码更短、界面上的名字也不必被迫写成"德语（德国）"。
    //
    // 这条断言把"别把基础语言码顺手补成区域码"钉住 —— 改了它就要连界面上的名字一起想清楚。
    const regionCodes = SPELLCHECK_LANGUAGES.map((entry) => entry.code).filter((code) =>
      code.includes('-'),
    )

    expect(regionCodes.sort()).toEqual(['en-GB', 'en-US', 'pt-BR'])
  })

  it('刻意不含中文 —— 内核的词典清单里没有它（列上去等于一个永远不生效的选项）', () => {
    const chinese = SPELLCHECK_LANGUAGES.filter((entry) => entry.code.startsWith('zh'))

    expect(chinese).toEqual([])
  })

  it('默认词典在表里', () => {
    expect(SPELLCHECK_LANGUAGES.some((entry) => entry.code === DEFAULT_SPELLCHECK_LANGUAGES)).toBe(
      true,
    )
  })
})

describe('normalizeSpellcheckLanguages', () => {
  it('表内的码保序保留', () => {
    expect(normalizeSpellcheckLanguages('de,en-US')).toBe('de,en-US')
  })

  it('剔掉表外的码与重复项', () => {
    expect(normalizeSpellcheckLanguages('en-US,xx-XX,en-US,fr')).toBe('en-US,fr')
  })

  it('也剔掉表外的区域码（`de-DE` 内核其实认得，但我们统一用 `de`）', () => {
    // 与 SPELLCHECK_LANGUAGES 的命名约定配套：`de-DE` 不在**我们的表**里，因此它会被收敛掉，
    // 而不是被一路存到设置文件里、让界面显示一个表外的值。
    // （注意别把这条读成"内核不认识 `de-DE`" —— 实测它认得，只是我们不用那个形状。）
    expect(normalizeSpellcheckLanguages('de-DE')).toBe(DEFAULT_SPELLCHECK_LANGUAGES)
  })

  it('一个都不剩时回落到默认（空列表等于"什么都不查"，与"功能坏了"没有区别）', () => {
    for (const bad of ['', '  ', 'xx-XX', 'zh-CN', undefined, null, 7]) {
      expect(normalizeSpellcheckLanguages(bad)).toBe(DEFAULT_SPELLCHECK_LANGUAGES)
    }
  })
})

describe('resolveSpellcheckLanguages', () => {
  it('按内核实际支持的清单对账，分成"用得上"与"内核没有"两组', () => {
    const resolved = resolveSpellcheckLanguages('en-US,fr,de', ['en-US', 'de', 'es'])

    expect(resolved.applied).toEqual(['en-US', 'de'])
    expect(resolved.rejected).toEqual(['fr'])
  })

  it('两边都不去重之外的加工：输入里的重复项不会让同一个码出现两次', () => {
    const resolved = resolveSpellcheckLanguages('en-US,en-US', ['en-US'])

    expect(resolved.applied).toEqual(['en-US'])
    expect(resolved.rejected).toEqual([])
  })

  it('内核一个词典都没有时，全部落进 rejected（而不是悄悄什么都不做）', () => {
    const resolved = resolveSpellcheckLanguages('en-US', [])

    expect(resolved.applied).toEqual([])
    expect(resolved.rejected).toEqual(['en-US'])
  })

  it('空列表两边都空', () => {
    expect(resolveSpellcheckLanguages('', ['en-US'])).toEqual({ applied: [], rejected: [] })
  })
})
