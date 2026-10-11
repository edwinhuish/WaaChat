/**
 * 拼写检查词典的**判据表**。
 *
 * 语言是一组**语言码**，而"我们认识哪些码"必须有唯一的事实来源。因此本文件只放数据与纯函数
 * —— 不 import electron、不碰 DOM、不碰文件系统，于是主进程、渲染进程、单测与离线自检都能用它
 * （与 `size-limit.ts` / `settings-sections.ts` 同一个理由）。
 *
 * 「拼写检查」用的是内核自带的 Hunspell 检查器，红波浪线由渲染进程自己画，只是需要告诉内核
 * "要查哪些语言"（`session.setSpellCheckerLanguages`）—— 同样**不向被承载的页面注入任何东西**
 * （[INV-1]）。
 *
 * 表是**枚举白名单**而不是"接受任意输入"：设置文件是可以被手工编辑的，而一个我们不认识的语言码
 * 存下来之后，症状是"设置里显示 A、实际按 B 跑" —— 那正是 `settings.ts` 要避免的不一致。因此
 * {@link normalizeSpellcheckLanguages} 在**读设置的那一刻**就把值收敛到表内。
 *
 * 历史：本文件曾经也放**界面语言**那张表（`UI_LANGUAGES` / `pageLanguageCode` / `--lang` 的
 * 诊断函数）。[ADR-0066] 把「界面语言」这一项整个撤掉了 —— 实测证明登录之后语言由**账号**决定，
 * 我们在会话层做的任何固定都会被页面改回去（`docs/research/lang-preference.md` §4.5），
 * 连 INV-1 的写入例外也随之一并退休。那批代码与决定都留在 git 历史与 ADR 里。
 */

/** 拼写检查可选的一门词典。 */
export interface SpellcheckLanguage {
  /** 语言码，直接交给 `session.setSpellCheckerLanguages`。 */
  readonly code: string
  /** 界面上的名字（中文，同 {@link SpellcheckLanguage} 的其余各项）。 */
  readonly label: string
}

/**
 * 可选为拼写检查词典的语言。
 *
 * ⚠️ **码必须逐字出现在 `session.availableSpellCheckerLanguages` 里**，因为它会被原样交给
 * `setSpellCheckerLanguages()`：写错一个码的症状是"用户勾了德语、德语词照样被画红线"，而且
 * **没有任何报错**（判决见 `main/spellcheck.ts`）。
 *
 * 我们**统一用基础语言码**（`de` / `fr` / `nl` / `ru` …），只在真有区域变体意义时才带区域
 * （`en-US` / `en-GB` / `pt-BR`）。这是**我们的取舍**，不是内核的限制：实测 Electron 44.7 的
 * 清单是 57 门，`de` 与 `de-DE`、`fr` 与 `fr-FR`、`it` 与 `it-IT`、`es` 与 `es-ES` **都在**
 * 里面。之所以仍然写基础码，是因为两者等效而基础码更短、界面上的名字也不用被迫写成"德语（德国）"。
 *
 * ⚠️ 反过来，**中文不在内核清单里**（实测清单里没有任何 `zh*` 条目）—— 列上去就是一个永远
 * 不生效的选项，因此这里不列。这不是遗漏：Hunspell 那一套本来就是为词形语言做的。
 *
 * ⚠️ **这份清单仍然只是"候选人"**：真正能装哪些由内核决定，运行时以
 * `session.availableSpellCheckerLanguages` 为准 —— 主进程会把表里内核没有的那些**剔掉并记一条
 * 日志**（见 `main/spellcheck.ts`）。两处都留着是必要的：这里决定"界面上能勾什么"，内核决定
 * "勾了之后真的会不会查"；两者不一致时唯一的坏结果就是"勾了却不查"，那正是必须留痕的那种静默失效。
 *
 * ⚠️ **没有中文**，而且不是遗漏：Hunspell 是为**词形语言**做的（词与词之间有空格、拼写可以
 * 逐词判定）。中文没有词形拼写可查，内核的词典清单里也没有中文条目 —— 列上去只会让用户勾一个
 * 永远不生效的选项。
 */
export const SPELLCHECK_LANGUAGES: readonly SpellcheckLanguage[] = [
  { code: 'en-US', label: '英语（美国）' },
  { code: 'en-GB', label: '英语（英国）' },
  { code: 'de', label: '德语' },
  { code: 'fr', label: '法语' },
  { code: 'es', label: '西班牙语' },
  { code: 'pt-BR', label: '葡萄牙语（巴西）' },
  { code: 'it', label: '意大利语' },
  { code: 'nl', label: '荷兰语' },
  { code: 'sv', label: '瑞典语' },
  { code: 'da', label: '丹麦语' },
  { code: 'nb', label: '挪威语' },
  { code: 'pl', label: '波兰语' },
  { code: 'cs', label: '捷克语' },
  { code: 'sk', label: '斯洛伐克语' },
  { code: 'hu', label: '匈牙利语' },
  { code: 'ro', label: '罗马尼亚语' },
  { code: 'hr', label: '克罗地亚语' },
  { code: 'el', label: '希腊语' },
  { code: 'ru', label: '俄语' },
  { code: 'uk', label: '乌克兰语' },
  { code: 'tr', label: '土耳其语' },
  { code: 'id', label: '印度尼西亚语' },
  { code: 'vi', label: '越南语' },
  { code: 'ko', label: '韩语' },
]

/**
 * 默认词典：英语（美国）。
 *
 * 为什么不跟随**系统语言**：输入内容的语言与系统/界面的语言是两件事 —— 一台切到日语的机器上，
 * 用户照样可能在用英语打字。把两者绑在一起会得到"系统改了、拼写检查跟着变"这种没人要的联动，
 * 而联动本身**看不出来**，用户只会觉得拼写检查坏了。因此默认值写死，改由用户自己勾。
 */
export const DEFAULT_SPELLCHECK_LANGUAGES = 'en-US'

/**
 * 逗号分隔的语言列表 → 语言码数组。
 *
 * 用逗号分隔的字符串而不是数组来**存**：拼写词典是一组**顺序无关**的语言码，而设置层是逐字段
 * 按类型校验的（`settings.ts` 的 `coerce()`）—— 为"数组"这一种新类型单开一套校验不值当，
 * 而且同一份值在设置界面里本来就是一个多选控件。
 */
export function parseLanguageList(value: string): string[] {
  const seen = new Set<string>()
  const codes: string[] = []

  for (const part of value.split(',')) {
    const code = part.trim()
    if (code === '' || seen.has(code)) continue

    seen.add(code)
    codes.push(code)
  }

  return codes
}

/** 语言码数组 → 逗号分隔的列表。 */
export function formatLanguageList(codes: readonly string[]): string {
  return codes.join(',')
}

/** 把一个不可信的值收敛成一行合法的词典列表（读设置时用）。 */
export function normalizeSpellcheckLanguages(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SPELLCHECK_LANGUAGES

  const known = new Set(SPELLCHECK_LANGUAGES.map((entry) => entry.code))
  const kept = parseLanguageList(value).filter((code) => known.has(code))

  // 一个都不剩（空串、或者全是我们不认识的值）时回落到默认 —— 空列表交给内核等于
  // "什么都不查"，而那与"功能坏了"在用户看来没有区别。
  return kept.length === 0 ? DEFAULT_SPELLCHECK_LANGUAGES : formatLanguageList(kept)
}

/** 一次"请求哪些词典"的解析结果。 */
export interface SpellcheckResolution {
  /** 真正交给内核的那些（请求 ∩ 内核有词典）。 */
  readonly applied: readonly string[]
  /**
   * 请求了但内核没有词典的那些。
   *
   * 单独返回而不是丢掉：这一支是**静默失效**的入口（用户勾了法语、法语词典下载不到，
   * 于是英文以外的词全被画上红线），至少要有一条日志说清为什么。
   */
  readonly rejected: readonly string[]
}

/**
 * 把设置里的词典列表与内核实际支持的清单对账。
 *
 * `available` 由调用方从 `session.availableSpellCheckerLanguages` 取 —— 它是内核的事实，
 * 因此这个函数保持纯函数：给定同样的两个输入，结果就一样，可以单测。
 */
export function resolveSpellcheckLanguages(
  requested: string,
  available: readonly string[],
): SpellcheckResolution {
  const supported = new Set(available)
  const applied: string[] = []
  const rejected: string[] = []

  for (const code of parseLanguageList(requested)) {
    if (supported.has(code)) applied.push(code)
    else rejected.push(code)
  }

  return { applied, rejected }
}
