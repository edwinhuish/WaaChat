/**
 * 界面语言与拼写词典判据表的单测（`src/shared/language.ts`）。
 *
 * 为什么值得测：这两张表是两个功能的**唯一事实来源**，而它们出错的方式全都是安静的 ——
 * 表里写错一个语言码，症状是"上游没换语言"（看起来像上游不支持，不像我们的 bug）；
 * 拼写词典写错一个，症状是"勾了却不查"（红波浪线照样出现，只是划分得不对）。
 * 因此这里断言的是**表本身的性质**，而不是某一次调用的返回值。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SPELLCHECK_LANGUAGES,
  DEFAULT_UI_LANGUAGE,
  SPELLCHECK_LANGUAGES,
  UI_LANGUAGES,
  acceptLanguagesFor,
  formatLanguageList,
  normalizeSpellcheckLanguages,
  normalizeUiLanguage,
  parseLanguageList,
  resolveSpellcheckLanguages,
  uiLanguage,
} from '../../src/shared/language'

/** 取 `Accept-Language` 里的主语言（第一段、去掉 q 值）。 */
function primaryLanguage(acceptLanguages: string): string {
  const first = acceptLanguages.split(',')[0] ?? ''
  return first.split(';')[0]?.trim() ?? ''
}

describe('UI_LANGUAGES', () => {
  it('语言码不重复', () => {
    const codes = UI_LANGUAGES.map((entry) => entry.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('每一项的 Accept-Language 以它自己的语言码开头', () => {
    // 主语言与语言码不一致时，选的是一种语言、请求的却是另一种 —— 这种错排没人看得出来。
    for (const entry of UI_LANGUAGES) {
      expect(primaryLanguage(entry.acceptLanguages)).toBe(entry.code)
    }
  })

  it('语言码与 Accept-Language 都是纯 ASCII、逗号分隔、没有空格', () => {
    // 脏字符不会报错，只会让上游认不出这个头（`zh-CN , en` 里的空格就足以让部分实现只取到 " zh"）。
    for (const entry of UI_LANGUAGES) {
      expect(entry.code).toMatch(/^[a-z]{2}(-[A-Za-z]{2,4})?$/)
      expect(entry.acceptLanguages).toMatch(/^[A-Za-z0-9,;=.q-]+$/)
      expect(entry.acceptLanguages).not.toContain(' ')
      expect(entry.acceptLanguages).not.toContain(',,')
    }
  })

  it('每一项都有非空标签（界面上没有无名选项）', () => {
    for (const entry of UI_LANGUAGES) {
      expect(entry.label.trim()).not.toBe('')
    }
  })

  it('默认项在表里，且是简体中文', () => {
    expect(DEFAULT_UI_LANGUAGE).toBe('zh-CN')
    expect(UI_LANGUAGES.some((entry) => entry.code === DEFAULT_UI_LANGUAGE)).toBe(true)
  })

  it('表里没有「跟随系统」这一项（它会让"选了语言却没反应"看起来像 bug）', () => {
    expect(UI_LANGUAGES.some((entry) => entry.code === '')).toBe(false)
  })
})

describe('uiLanguage / acceptLanguagesFor', () => {
  it('认得出的码原样返回', () => {
    expect(uiLanguage('en-US').code).toBe('en-US')
    expect(acceptLanguagesFor('en-US')).toBe('en-US,en;q=0.9')
  })

  it('认不出的码回落到默认项，而不是抛错', () => {
    // 调用点在启动路径上：为一个被改坏的配置值让应用起不来，代价远大于"语言回到默认"。
    for (const bad of ['', 'xx-XX', 'zh-CN,en', 'zh']) {
      expect(uiLanguage(bad).code).toBe(DEFAULT_UI_LANGUAGE)
      expect(acceptLanguagesFor(bad)).toBe(acceptLanguagesFor(DEFAULT_UI_LANGUAGE))
    }
  })
})

describe('normalizeUiLanguage', () => {
  it('只放行表里的语言码', () => {
    expect(normalizeUiLanguage('en-US')).toBe('en-US')
    expect(normalizeUiLanguage('zh-TW')).toBe('zh-TW')
  })

  it('坏值（类型不对 / 表外 / 空）一律收敛到默认', () => {
    expect(normalizeUiLanguage(undefined)).toBe(DEFAULT_UI_LANGUAGE)
    expect(normalizeUiLanguage(null)).toBe(DEFAULT_UI_LANGUAGE)
    expect(normalizeUiLanguage(42)).toBe(DEFAULT_UI_LANGUAGE)
    expect(normalizeUiLanguage({ code: 'en-US' })).toBe(DEFAULT_UI_LANGUAGE)
    expect(normalizeUiLanguage('')).toBe(DEFAULT_UI_LANGUAGE)
    expect(normalizeUiLanguage('xx-XX')).toBe(DEFAULT_UI_LANGUAGE)
  })
})

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

  it('用的是内核的词典命名：区域码只出现在真有区域变体的那几门语言上', () => {
    // `de-DE` 这种写法看起来更规范，但内核的清单里没有它 —— 勾了之后**不报错也不生效**。
    // 这条断言把"别把基础语言码补成区域码"钉住。
    const regionCodes = SPELLCHECK_LANGUAGES.map((entry) => entry.code).filter((code) =>
      code.includes('-'),
    )

    expect(regionCodes.sort()).toEqual(['en-GB', 'en-US', 'pt-BR'])
  })

  it('刻意不含中文 —— 内核的词典清单里没有它（列上去等于一个永远不生效的选项）', () => {
    const chinese = SPELLCHECK_LANGUAGES.filter((entry) => entry.code.startsWith('zh'))

    expect(chinese).toEqual([])
    // 反过来说，界面语言表里是有中文的：两张表回答的是两个不同的问题，别把它们的差异当成笔误。
    expect(UI_LANGUAGES.some((entry) => entry.code.startsWith('zh'))).toBe(true)
  })

  it('默认词典在表里', () => {
    expect(SPELLCHECK_LANGUAGES.some((entry) => entry.code === DEFAULT_SPELLCHECK_LANGUAGES)).toBe(
      true,
    )
  })
})

describe('normalizeSpellcheckLanguages', () => {
  it('表内的码保序保留', () => {
    expect(normalizeSpellcheckLanguages('de-DE,en-US')).toBe('de-DE,en-US')
  })

  it('剔掉表外的码与重复项', () => {
    expect(normalizeSpellcheckLanguages('en-US,xx-XX,en-US,fr-FR')).toBe('en-US,fr-FR')
  })

  it('一个都不剩时回落到默认（空列表等于"什么都不查"，与"功能坏了"没有区别）', () => {
    for (const bad of ['', '  ', 'xx-XX', 'zh-CN', undefined, null, 7]) {
      expect(normalizeSpellcheckLanguages(bad)).toBe(DEFAULT_SPELLCHECK_LANGUAGES)
    }
  })
})

describe('resolveSpellcheckLanguages', () => {
  it('按内核实际支持的清单对账，分成"用得上"与"内核没有"两组', () => {
    const resolved = resolveSpellcheckLanguages('en-US,fr-FR,de-DE', ['en-US', 'de-DE', 'es-ES'])

    expect(resolved.applied).toEqual(['en-US', 'de-DE'])
    expect(resolved.rejected).toEqual(['fr-FR'])
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
