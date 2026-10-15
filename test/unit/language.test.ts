/**
 * 拼写词典判据表的单测（`src/shared/language.ts`）。
 *
 * 为什么值得测：这张表是「拼写检查」那一项**唯一**的事实来源，而它出错的方式全是安静的 ——
 * 表里写错一个语言码，症状是"勾了却不查"（红波浪线照样出现，只是划分得不对）；写进一个内核
 * 没有的码，那一项永远不生效。因此这里断言的是**表本身的性质**，而不是某一次调用的返回值。
 *
 * [ADR-0087] 之后这里还测两件**看着差不多**的事：清单的**次序**（拖动与「上移 / 下移」都算它）
 * 与每一项的**开关**（`-` 前缀）。它们错一格都不会报错，只会让人觉得"拖完了位置不对"，
 * 或者"我关掉的那一门怎么又在查了"。
 *
 * 历史：这个文件也测过**界面语言**那张表（`--lang` 的规范化、网页版那条偏好 cookie 的写法）。
 * [ADR-0066] 撤掉那一整项之后，那些用例与被测的代码一起删掉了 —— 实测结论留在
 * `docs/research/lang-preference.md` §4.5，决定留在 ADR 里。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SPELLCHECK_LANGUAGES,
  SPELLCHECK_LANGUAGES,
  enabledLanguageCodes,
  ensureEnabledDictionary,
  formatDictionaryList,
  moveDictionary,
  normalizeSpellcheckLanguages,
  parseDictionaryList,
  resolveSpellcheckLanguages,
  stepDictionary,
  type SpellcheckEntry,
} from '../../src/shared/language'

describe('parseDictionaryList / formatDictionaryList', () => {
  it('按逗号切分，去空白、去空项、去重且保序', () => {
    expect(parseDictionaryList('en-US, de-DE ,,en-US,fr-FR')).toEqual([
      { code: 'en-US', enabled: true },
      { code: 'de-DE', enabled: true },
      { code: 'fr-FR', enabled: true },
    ])
  })

  it('空串得到空数组', () => {
    expect(parseDictionaryList('')).toEqual([])
    expect(parseDictionaryList(' , , ')).toEqual([])
  })

  it('往返一致（含每一项的开关）', () => {
    for (const value of ['en-US,de-DE', 'en-US,-de', '-de,-fr', 'de']) {
      expect(formatDictionaryList(parseDictionaryList(value))).toBe(value)
    }
  })

  it('`-` 前缀表示"留在清单里但不参与检查"，重复的码只留第一次出现的那个状态', () => {
    expect(parseDictionaryList('-de,de')).toEqual([{ code: 'de', enabled: false }])
  })

  it('只有一个 `-`（没有码）的那一项丢掉，而不是变成一个叫 "-" 的语言', () => {
    expect(parseDictionaryList('en-US,-')).toEqual([{ code: 'en-US', enabled: true }])
  })

  it('enabledLanguageCodes 只挑出参与检查的那些，且保序', () => {
    expect(enabledLanguageCodes('en-US,-de,fr')).toEqual(['en-US', 'fr'])
    expect(enabledLanguageCodes('-de')).toEqual([])
  })
})

describe('ensureEnabledDictionary', () => {
  it('一门启用的都没有时，把第一项打开（而不是把清单丢掉重新来过）', () => {
    expect(ensureEnabledDictionary(parseDictionaryList('-de,-fr'))).toEqual([
      { code: 'de', enabled: true },
      { code: 'fr', enabled: false },
    ])
  })

  it('已经有一门启用时一个字节都不动', () => {
    const entries = parseDictionaryList('-de,en-US')
    expect(ensureEnabledDictionary(entries)).toEqual(entries)
  })

  it('第一项停用、后面有一门启用时**不许**把第一项打开', () => {
    // 这条正是"门开在哪儿"的坑：判据必须是"清单里有没有启用的"，而不是"第一项是不是启用的" ——
    // 后者会顺手把用户刚关掉的那一门重新打开。
    expect(ensureEnabledDictionary(parseDictionaryList('-de,en-US,-fr'))).toEqual([
      { code: 'de', enabled: false },
      { code: 'en-US', enabled: true },
      { code: 'fr', enabled: false },
    ])
  })

  it('空清单保持空（回落默认值是 normalizeSpellcheckLanguages 的事）', () => {
    expect(ensureEnabledDictionary([])).toEqual([])
  })
})

describe('moveDictionary', () => {
  const entries: SpellcheckEntry[] = parseDictionaryList('en-US,de,fr,ko')

  it('往下拖：插到目标那一行的后面', () => {
    expect(formatDictionaryList(moveDictionary(entries, 'en-US', 'fr', true))).toBe(
      'de,fr,en-US,ko',
    )
  })

  it('往上拖：插到目标那一行的前面', () => {
    expect(formatDictionaryList(moveDictionary(entries, 'ko', 'de', false))).toBe('en-US,ko,de,fr')
  })

  it('拖到自己身上是空操作', () => {
    expect(formatDictionaryList(moveDictionary(entries, 'de', 'de', false))).toBe('en-US,de,fr,ko')
  })

  it('落点不在清单里时原样返回（拖动期间清单可能被换掉）', () => {
    expect(formatDictionaryList(moveDictionary(entries, 'de', 'xx-XX', true))).toBe(
      'en-US,de,fr,ko',
    )
    expect(formatDictionaryList(moveDictionary(entries, 'xx-XX', 'de', true))).toBe(
      'en-US,de,fr,ko',
    )
  })

  it('被挪的那一项的开关跟着它一起走（`moveDictionary` 认的是语言码，不带 `-`）', () => {
    const withDisabled = parseDictionaryList('en-US,-de,fr')
    expect(formatDictionaryList(moveDictionary(withDisabled, 'de', 'en-US', false))).toBe(
      '-de,en-US,fr',
    )
  })
})

describe('stepDictionary', () => {
  const entries: SpellcheckEntry[] = parseDictionaryList('en-US,de,fr')

  it('往后一格', () => {
    expect(formatDictionaryList(stepDictionary(entries, 'en-US', 1))).toBe('de,en-US,fr')
  })

  it('往前一格', () => {
    expect(formatDictionaryList(stepDictionary(entries, 'fr', -1))).toBe('en-US,fr,de')
  })

  it('到头 / 到底时原样返回（`⋯` 里那两项因此可以据它禁用）', () => {
    expect(formatDictionaryList(stepDictionary(entries, 'en-US', -1))).toBe('en-US,de,fr')
    expect(formatDictionaryList(stepDictionary(entries, 'fr', 1))).toBe('en-US,de,fr')
    expect(formatDictionaryList(stepDictionary(entries, 'xx-XX', 1))).toBe('en-US,de,fr')
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

  it('停用的那一门留在清单里，连它前面那个 `-` 一起（[ADR-0087]）', () => {
    expect(normalizeSpellcheckLanguages('en-US,-de')).toBe('en-US,-de')
    expect(normalizeSpellcheckLanguages('-de,en-US')).toBe('-de,en-US')
  })

  it('别的门被剔掉时，剩下那一门的开关跟着它走', () => {
    expect(normalizeSpellcheckLanguages('en-US,-de,xx-XX')).toBe('en-US,-de')
  })

  it('全都被停用时把**第一项**打开，而不是整体回落成默认值', () => {
    // 回落成默认值会连着把用户排的清单与次序一起丢掉 —— 那看起来像"它自己变回去了"。
    expect(normalizeSpellcheckLanguages('-de,-fr')).toBe('de,-fr')
  })

  it('空清单与"全都停用"是两回事：前者回落默认，后者保住清单', () => {
    expect(normalizeSpellcheckLanguages('')).toBe(DEFAULT_SPELLCHECK_LANGUAGES)
    expect(normalizeSpellcheckLanguages('-de')).toBe('de')
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

  it('被停用的那一门不交给内核，也不算"内核没有"（[ADR-0087]）', () => {
    // ⚠️ 它不能落进 `rejected`：那条日志是给"用户勾了、但内核没有这门词典"用的静默失效入口，
    // 把用户自己关掉的码混进去就会把它埋掉。
    expect(resolveSpellcheckLanguages('en-US,-de', ['en-US'])).toEqual({
      applied: ['en-US'],
      rejected: [],
    })
    expect(resolveSpellcheckLanguages('-de', ['en-US', 'de'])).toEqual({
      applied: [],
      rejected: [],
    })
  })
})
