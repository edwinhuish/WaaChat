/**
 * 界面语言与拼写检查词典的**判据表**。
 *
 * 两项功能建立在同一件事上：语言是一组**语言码**，而"我们认识哪些码"必须有唯一的事实来源。
 * 因此本文件只放数据与纯函数 —— 不 import electron、不碰 DOM、不碰文件系统，于是主进程、
 * 渲染进程、单测与离线自检都能用它（与 `size-limit.ts` / `settings-sections.ts` 同一个理由）。
 *
 * 两项功能都**不向被承载的页面注入任何东西**（[INV-1]）：
 *
 *   - 「界面语言」落在**两处**，缺一不可（[ADR-0063]）：启动时的 `--lang` 开关决定
 *     `navigator.language`（网页版真正看的那个），会话的 `Accept-Language` 头负责请求层的有序
 *     回退。因此它**改完要重启应用**才生效 —— 网页版是纯 JS 应用，要改已经渲染好的文本只剩注入。
 *   - 「拼写检查」用的是内核自带的 Hunspell 检查器，红波浪线由渲染进程自己画，
 *     只是需要告诉内核"要查哪些语言"（`session.setSpellCheckerLanguages`）。
 *
 * 两个表都是**枚举白名单**而不是"接受任意输入"：设置文件是可以被手工编辑的，而一个我们不
 * 认识的语言码存下来之后，症状是"设置里显示 A、实际按 B 跑" —— 那正是 `settings.ts` 要避免的
 * 不一致。因此 {@link normalizeUiLanguage} / {@link normalizeSpellcheckLanguages} 在**读设置
 * 的那一刻**就把值收敛到表内。
 */

/** 一项可选的界面语言。 */
export interface UiLanguage {
  /** 我们存储与比较用的语言码，同时也是 Chromium 认的那种（例如 `zh-CN`）。 */
  readonly code: string
  /** 界面上的名字。按 `ai/CONVENTIONS.md` 第 1 节，面向用户的文案用中文。 */
  readonly label: string
  /**
   * 交给会话的 `Accept-Language`：**有序、逗号分隔的纯语言码**（第一项是主语言，其余是回退）。
   *
   * ⚠️ **不要自己写 `;q=` 值。** q 值由 Chromium 自己按顺序排（实测 Electron 44.7）：
   * 给 `'ja-JP,ja,en-US,en'` 得到的头就是 `ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7`。手写反而
   * 会被当成**语言标签的一部分**原样拼进去 —— 给 `'en-US,en;q=0.9'` 得到的是
   * `en-US,en;q=0.9;q=0.9`（q 值重复、`en` 后面拖着一个畸形参数）。见 [ADR-0063]。
   *
   * 回退项是必要的：上游未必有我们主语言的那一套文案，没有回退就会掉到它的默认语言（通常是英语）。
   *
   * ⚠️ 这个头**只**影响网络层。它**改不动** `navigator.language`（实测：只设这个头时
   * `navigator.language` 依旧是系统的 `zh-CN`），而网页版是纯 JS 应用、按 `navigator.language`
   * 挑语言包 —— 真正决定界面语言的是启动时的 `--lang` 开关，见 [ADR-0063]。两者互不替代。
   */
  readonly acceptLanguages: string
}

/** 默认的界面语言。取简体中文：这个项目的界面文案本身就是中文（`ai/CONVENTIONS.md` 第 1 节）。 */
const ZH_CN: UiLanguage = {
  code: 'zh-CN',
  label: '简体中文',
  acceptLanguages: 'zh-CN,zh,en-US,en',
}

/**
 * 可选的界面语言。
 *
 * 这份清单是**上游网页版实际提供的语言**与我们愿意维护的标签的交集，不是 Chromium 支持的全部
 * 语言 —— 多列一种上游没有的语言，用户切过去只会得到一个"好像没变"的结果。
 * 清单里**没有**「跟随系统」这一项：它看似礼貌，实际后果是"用户以为选了语言、其实什么都没做"，
 * 而真正想要系统语言的用户只要选那一项就行。
 */
export const UI_LANGUAGES: readonly UiLanguage[] = [
  ZH_CN,
  { code: 'zh-TW', label: '繁體中文', acceptLanguages: 'zh-TW,zh-Hant,zh,en' },
  { code: 'en-US', label: '英语（美国）', acceptLanguages: 'en-US,en' },
  { code: 'en-GB', label: '英语（英国）', acceptLanguages: 'en-GB,en,en-US' },
  { code: 'ja-JP', label: '日语', acceptLanguages: 'ja-JP,ja,en-US,en' },
  { code: 'ko-KR', label: '韩语', acceptLanguages: 'ko-KR,ko,en-US,en' },
  { code: 'es-ES', label: '西班牙语', acceptLanguages: 'es-ES,es,en' },
  { code: 'pt-BR', label: '葡萄牙语（巴西）', acceptLanguages: 'pt-BR,pt,en' },
  { code: 'fr-FR', label: '法语', acceptLanguages: 'fr-FR,fr,en' },
  { code: 'de-DE', label: '德语', acceptLanguages: 'de-DE,de,en' },
  { code: 'it-IT', label: '意大利语', acceptLanguages: 'it-IT,it,en' },
  { code: 'ru-RU', label: '俄语', acceptLanguages: 'ru-RU,ru,en' },
  { code: 'tr-TR', label: '土耳其语', acceptLanguages: 'tr-TR,tr,en' },
  { code: 'id-ID', label: '印度尼西亚语', acceptLanguages: 'id-ID,id,en' },
  { code: 'vi-VN', label: '越南语', acceptLanguages: 'vi-VN,vi,en' },
  { code: 'th-TH', label: '泰语', acceptLanguages: 'th-TH,th,en' },
  { code: 'hi-IN', label: '印地语', acceptLanguages: 'hi-IN,hi,en-IN,en' },
  { code: 'ar', label: '阿拉伯语', acceptLanguages: 'ar,en-US,en' },
]

export const DEFAULT_UI_LANGUAGE: string = ZH_CN.code

/**
 * 一个语言码对应的完整条目。
 *
 * 认不出时回落到默认项而不是抛错：这个函数的调用点（会话配置）在**启动路径**上，
 * 为一个坏掉的配置值让应用起不来是得不偿失的。收敛到默认值是安全的 —— 它的后果只是
 * "界面语言回到了中文"，不是任何不可逆的动作。
 */
export function uiLanguage(code: string): UiLanguage {
  return UI_LANGUAGES.find((candidate) => candidate.code === code) ?? ZH_CN
}

/** 交给会话的 `Accept-Language`。见 {@link uiLanguage} 关于"认不出怎么办"的说明。 */
export function acceptLanguagesFor(code: string): string {
  return uiLanguage(code).acceptLanguages
}

/** 把一个不可信的值收敛成清单里的语言码（读设置时用）。 */
export function normalizeUiLanguage(value: unknown): string {
  return typeof value === 'string' && UI_LANGUAGES.some((entry) => entry.code === value)
    ? value
    : DEFAULT_UI_LANGUAGE
}

/**
 * 语言码的**基础语言**部分：`es-ES` → `es`，`zh-Hans-CN` → `zh`。
 *
 * ⚠️ 这个函数存在的唯一理由是**实测**（Electron 44.7，本仓库钉住的那一版）：`--lang` 交给
 * Chromium 之后，一部分区域变体会被**规范化成基础码**，另一部分原样保留 ——
 *
 * | `--lang=` | `navigator.language` |
 * |---|---|
 * | `es-ES` / `ja-JP` / `tr-TR` / `hi-IN` / `vi-VN` / `th-TH` / `id-ID` / `ko-KR` / `fr-FR` / `de-DE` / `it-IT` / `ru-RU` | 基础码（`es` / `ja` / …） |
 * | `en-US` / `en-GB` / `zh-CN` / `zh-TW` / `pt-BR` | 原样保留 |
 *
 * 因此"请求的值与生效的值不完全相同"**不是**失败 —— 比同一门语言就够了，见
 * {@link localeMatchesRequest}。完整实测见 `docs/research/lang-preference.md`。
 */
export function baseLanguage(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0] ?? ''
}

/**
 * 请求的界面语言与内核**实际生效**的 locale 是不是同一门语言（判据见 {@link baseLanguage}）。
 *
 * 判据必须是"基础语言相同"而不是"字符串相同"：后者会把上表那一整列规范化当成失败，
 * 每次都报一次假警报 —— 而假警报的代价是真正的失败不再有人看。
 *
 * ⚠️ 它有一个**盲区**：系统语言与请求的语言同属一门时（系统 `es-MX`、请求 `es-ES`），
 * 内核回落到系统 locale 与"正常生效"看不出来。那里没有杠杆，只能把两个值都记下来。
 */
export function localeMatchesRequest(requested: string, effective: string): boolean {
  const requestedBase = baseLanguage(requested)
  return requestedBase !== '' && requestedBase === baseLanguage(effective)
}

/** 拼写检查可选的一门词典。 */
export interface SpellcheckLanguage {
  /** 语言码，直接交给 `session.setSpellCheckerLanguages`。 */
  readonly code: string
  /** 界面上的名字（中文，同 {@link UiLanguage.label}）。 */
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
 * 不生效的选项，因此这里不列。别把"界面语言表里有中文"当成这里的笔误：两张表回答的是两个
 * 不同的问题。
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
 * 逐条说明为什么不是"跟随界面语言"：界面语言与**输入内容的语言**是两件事 ——
 * 一个把界面切成日语的用户，照样可能在用英语打字。把两者绑在一起会得到"改了界面语言、
 * 拼写检查跟着变"这种没人要的联动，而联动本身**看不出来**，用户只会觉得拼写检查坏了。
 */
export const DEFAULT_SPELLCHECK_LANGUAGES = 'en-US'

/**
 * 逗号分隔的语言列表 → 语言码数组。
 *
 * 用逗号分隔的字符串而不是数组来**存**：Electron 自己的 `acceptLanguages` 就是这个形状，
 * 而拼写词典是一组**顺序无关**的语言码 —— 一个形状表达两者，设置层就不必为"数组"这一种
 * 新类型开一个口子（`settings.ts` 的 `coerce()` 逐字段只比类型，数组在那里要额外写一套）。
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
