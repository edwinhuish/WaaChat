/**
 * 拼写词典判据表的单测（`src/shared/language.ts`）。
 *
 * 为什么值得测：这张表是「拼写检查」那一项**唯一**的事实来源，而它出错的方式全是安静的 ——
 * 表里写错一个语言码，症状是"勾了却不查"（红波浪线照样出现，只是划分得不对）；写进一个内核
 * 没有的码，那一项永远不生效。因此这里断言的是**表本身的性质**，而不是某一次调用的返回值。
 *
 * [ADR-0087] 之后这里还测清单的**次序**（拖动与「上移 / 下移」都算它）—— 它错一格都不会报错，
 * 只会让人觉得"拖完了位置不对"。[ADR-0089] 之后次序**真的有用**了：它是"界面语言匹配不上时"的
 * 回落顺序（{@link pickSpellcheckLanguage} 的第 2 段），因此那几条用例从"看着差不多"变成了
 * 真会影响查哪一门的东西。
 *
 * 历史：这个文件也测过**界面语言**那张表（`--lang` 的规范化、网页版那条偏好 cookie 的写法）。
 * [ADR-0066] 撤掉那一整项之后，那些用例与被测的代码一起删掉了 —— 实测结论留在
 * `docs/research/lang-preference.md` §4.5，决定留在 ADR 里。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SPELLCHECK_LANGUAGES,
  SPELLCHECK_LANGUAGES,
  adoptInterfaceDictionary,
  formatDictionaryList,
  isLanguageCode,
  matchDictionaryLanguage,
  moveDictionary,
  normalizeSpellcheckLanguages,
  parseDictionaryList,
  pickSpellcheckLanguage,
  resolveSpellcheckLanguages,
  stepDictionary,
} from '../../src/shared/language'

describe('parseDictionaryList / formatDictionaryList', () => {
  it('按逗号切分，去空白、去空项、去重且保序', () => {
    expect(parseDictionaryList('en-US, de-DE ,,en-US,fr-FR')).toEqual(['en-US', 'de-DE', 'fr-FR'])
  })

  it('空串得到空数组', () => {
    expect(parseDictionaryList('')).toEqual([])
    expect(parseDictionaryList(' , , ')).toEqual([])
  })

  it('往返一致', () => {
    for (const value of ['en-US,de-DE', 'de,en-US', 'es,en-US,fr']) {
      expect(formatDictionaryList(parseDictionaryList(value))).toBe(value)
    }
  })

  it('只有一个 `-`（没有码）的那一项丢掉，而不是变成一个叫 "-" 的语言', () => {
    expect(parseDictionaryList('en-US,-')).toEqual(['en-US'])
  })

  it('旧值里那个"停用"记号（`-`）被去掉，而不是把那一门丢掉（[ADR-0089]）', () => {
    // 既有的 `settings.json` 里可能有 `"en-US,-de"`：那一门曾经是"留在清单里但不参与检查"。
    // 现在没有逐门开关了，最不该发生的是"升级之后用户发现自己少了一门"。
    expect(parseDictionaryList('en-US,-de')).toEqual(['en-US', 'de'])
    expect(parseDictionaryList('-de')).toEqual(['de'])
  })
})

describe('moveDictionary', () => {
  const entries = parseDictionaryList('en-US,de,fr,ko')

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
})

describe('stepDictionary', () => {
  const entries = parseDictionaryList('en-US,de,fr')

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

  it('旧值里那个"停用"记号（`-`）在收敛时被抹掉，那一门保住（[ADR-0089]）', () => {
    // 升级路径：既有的 `settings.json` 里可能是 `"en-US,-de"`。逐门开关没有了，那一门因此
    // 回到"一直参与候选" —— 它不该被当成表外的值剔掉（那会让人以为"升级之后少了一门"）。
    expect(normalizeSpellcheckLanguages('en-US,-de')).toBe('en-US,de')
    expect(normalizeSpellcheckLanguages('-de')).toBe('de')
  })
})

describe('pickSpellcheckLanguage', () => {
  it('界面语言匹配到的那一门**在清单里**时就是它（哪怕它排在后面）', () => {
    expect(pickSpellcheckLanguage('en-US,es', 'es_LA')).toBe('es')
    // 区域也要认：界面是英式英语、清单里也有 `en-GB` 时，挑的是它而不是排第一的 `en-US`。
    expect(pickSpellcheckLanguage('en-US,en-GB,fr', 'en_GB')).toBe('en-GB')
  })

  it('匹配不上时用**清单的第一门**（次序就是回落顺序，[ADR-0087] + [ADR-0089]）', () => {
    expect(pickSpellcheckLanguage('es,en-US', 'zh_CN')).toBe('es')
    expect(pickSpellcheckLanguage('es,en-US', 'ja')).toBe('es')
  })

  it('匹配到的那一门**不在清单里**时也不动清单 —— 只按次序回落（补清单是 adoptInterfaceDictionary 的事）', () => {
    // ⚠️ 这一条是"只挑一门"能不能站住的关键：挑的那一步**不许**顺手改设置。
    expect(pickSpellcheckLanguage('en-US,de', 'es_LA')).toBe('en-US')
  })

  it('界面语言还不知道时按次序回落', () => {
    expect(pickSpellcheckLanguage('es,en-US', null)).toBe('es')
  })

  it('清单是空的就什么都没有（设置层保证至少一门，这一格因此只是兜底）', () => {
    expect(pickSpellcheckLanguage('', 'es')).toBeNull()
  })

  it('**至多一门**：交多门会回到并集语义（[ADR-0075]）', () => {
    const picked = pickSpellcheckLanguage('es,en-US,de', 'es')
    expect(picked === null || typeof picked === 'string').toBe(true)
    expect(picked).toBe('es')
  })
})

describe('resolveSpellcheckLanguages', () => {
  it('挑中的那一门内核有时进 applied', () => {
    expect(resolveSpellcheckLanguages('en-US,es', 'es_LA', ['en-US', 'es'])).toEqual({
      applied: ['es'],
      rejected: [],
    })
  })

  it('挑中的那一门内核没有时进 rejected（而不是悄悄什么都不做）', () => {
    // 这一支是静默失效的入口：清单里排着法语、内核没有那门词典，于是所有词全被画上红线。
    expect(resolveSpellcheckLanguages('en-US,fr', 'fr_FR', ['en-US'])).toEqual({
      applied: [],
      rejected: ['fr'],
    })
  })

  it('内核一个词典都没有时，挑中的那一门落进 rejected', () => {
    expect(resolveSpellcheckLanguages('en-US', null, [])).toEqual({
      applied: [],
      rejected: ['en-US'],
    })
  })

  it('空清单两边都空', () => {
    expect(resolveSpellcheckLanguages('', 'es', ['en-US'])).toEqual({
      applied: [],
      rejected: [],
    })
  })

  it('**只交一门**：清单里排着好几门，也只有挑中的那门进 applied', () => {
    // ⚠️ 多门并用会回到 [ADR-0075] 实测的并集语义 —— 那正是"界面是西语、却给我英语建议"的根因。
    const resolved = resolveSpellcheckLanguages('es,en-US,de', 'es', ['es', 'en-US', 'de'])
    expect(resolved.applied).toEqual(['es'])
  })
})

describe('isLanguageCode', () => {
  it('认得出语言码的形状，认不出别的', () => {
    for (const value of ['en', 'en_US', 'zh-Hans-CN', 'pt_BR']) {
      expect(isLanguageCode(value)).toBe(true)
    }

    // 它只用来决定"这条 cookie 的值能不能进日志"，因此宁可少认也不要多认。
    for (const value of ['', '1234', 'a'.repeat(40), 'en-US-extra-long-region']) {
      expect(isLanguageCode(value)).toBe(false)
    }
  })
})

describe('matchDictionaryLanguage', () => {
  it('先认区域：条目里真有那门区域变体时用它，而不是表里排第一的那一门', () => {
    expect(matchDictionaryLanguage('en_GB')).toBe('en-GB')
    expect(matchDictionaryLanguage('en-US')).toBe('en-US')
    expect(matchDictionaryLanguage('pt_BR')).toBe('pt-BR')
  })

  it('大小写与 `_`/`-` 都不影响判定（值由上游写，形状不该是前提）', () => {
    expect(matchDictionaryLanguage('EN_gb')).toBe('en-GB')
    expect(matchDictionaryLanguage('  es-la  ')).toBe('es')
  })

  it('区域是我们没有的那一个时，按表里的顺序落回基础语言', () => {
    // `en_AU` 落回 `en-US` 而不是 `en-GB`：表里 `en-US` 在前。这条断言钉的是"表顺序是判据的
    // 一部分"，而不是某一次巧合。
    expect(matchDictionaryLanguage('en_AU')).toBe('en-US')
    expect(matchDictionaryLanguage('de_DE')).toBe('de')
    expect(matchDictionaryLanguage('es_419')).toBe('es')
    expect(matchDictionaryLanguage('pt_PT')).toBe('pt-BR')
  })

  it('我们这 24 门里没有这一门时返回 `null`（中文、日语都不是遗漏）', () => {
    for (const value of ['zh_CN', 'zh-Hans-CN', 'ja', 'ja_JP', '', '   ']) {
      expect(matchDictionaryLanguage(value)).toBeNull()
    }
  })
})

describe('adoptInterfaceDictionary', () => {
  it('清单还停在写死的默认值上时，直接换成界面语言那一门（取代 en-US）', () => {
    expect(adoptInterfaceDictionary(DEFAULT_SPELLCHECK_LANGUAGES, 'es', false)).toBe('es')
    expect(adoptInterfaceDictionary(DEFAULT_SPELLCHECK_LANGUAGES, 'de', true)).toBe('de')
  })

  it('已经在清单里时什么都不做（无论它排在第几位）', () => {
    expect(adoptInterfaceDictionary('es', 'es', true)).toBeNull()
    expect(adoptInterfaceDictionary('de,es', 'es', true)).toBeNull()
  })

  it('界面语言在我们这 24 门里没有对应时，一个字节都不动', () => {
    expect(adoptInterfaceDictionary(DEFAULT_SPELLCHECK_LANGUAGES, null, true)).toBeNull()
  })

  it('启动那一次不碰用户排过的清单（拿**上次**的语言去改它就是在跟用户抢）', () => {
    expect(adoptInterfaceDictionary('en-US,de', 'es', false)).toBeNull()
    expect(adoptInterfaceDictionary('de,fr', 'es', false)).toBeNull()
  })

  it('界面语言**真的变了**时，把它补进第一位，其余一个字节都不动', () => {
    // ⚠️ 补进第一位不是装饰：[ADR-0089] 之后清单的次序就是"匹配不上时的回落顺序"，
    // 而界面语言那门一旦进了清单，{@link pickSpellcheckLanguage} 就会挑中它。
    expect(adoptInterfaceDictionary('en-US,de', 'es', true)).toBe('es,en-US,de')
    expect(adoptInterfaceDictionary('de,fr', 'es', true)).toBe('es,de,fr')
  })

  it('换掉默认值那一格要求"恰好只有那一门" —— 用户排过的清单不换', () => {
    expect(adoptInterfaceDictionary('de', 'es', false)).toBeNull()
    expect(adoptInterfaceDictionary('de', 'es', true)).toBe('es,de')
  })
})
