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
 * 清单里的每一项还带一件小事：**这一门参不参与检查**（`-` 前缀，见 {@link SpellcheckEntry}，
 * [ADR-0087]）。它与"清单的次序"都只在本文件里解析与组装，因此设置层存下的仍然只是一个字符串
 * —— `settings.ts` 的 `coerce()` 依旧只按 `typeof` 比对。
 *
 * ⚠️ 次序是**用户**排的（拖动整行，或 `⋯` 里的「上移 / 下移」），但它是清单**自己的**次序，
 * 不是优先级：内核把列出的语言当**一组**查（[ADR-0075] 的并集语义，实测），排第一与排最后的一门
 * 一样会被查。因此界面上不许把这件事说成"首选语言"，理由见 [ADR-0070] 对「移到顶部」的否决与
 * [ADR-0087] 接下它时写下的边界。
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
 * 清单里的一项。
 *
 * `enabled === false` 表示**这一门在清单里、但不参与检查**（[ADR-0087]）：用户先前勾了它，
 * 只是这一阵子不想用它查错别字。它与"从清单里删掉"是两件事 —— 删掉之后要再用它，得回到对话框里
 * 重新搜一遍；而顺序与状态都会被原样保住。
 */
export interface SpellcheckEntry {
  readonly code: string
  readonly enabled: boolean
}

/**
 * 「留在清单里但不参与检查」的记号：语言码前面一个 `-`。
 *
 * 为什么挤进同一个字段，而不是另开一个"被停用的那些"：清单的**次序**与每一项的**开关**是同一条
 * 清单上的两个属性 —— 分成两份状态就会出现"在一个里删了、另一个里还留着"这种要额外对账的形状，
 * 而且两份状态各自的顺序还得各自维护。存成一个字符串还意味着设置层不必为"数组"这一种新类型单开
 * 一套逐字段校验（`settings.ts` 的 `coerce()` 只按 `typeof` 比对）。
 *
 * `settings.json` 里因此长这样：`"spellcheckLanguages": "en-US,-de"`。
 */
export const DISABLED_DICTIONARY_PREFIX = '-'

/**
 * 清单串 → 有序的 {@link SpellcheckEntry}[]。
 *
 * 按逗号切分、去空白、去空项、**去重且保序**（每一项多带回自己的开关）。刻意**不认识**语言码
 * —— 那是 {@link normalizeSpellcheckLanguages} 的事：{@link resolveSpellcheckLanguages} 要能
 * 说出"内核实有的那些"，在这里就把它滤掉的话，就没有人能报告"内核没有这门词典"了。
 */
export function parseDictionaryList(value: string): SpellcheckEntry[] {
  const seen = new Set<string>()
  const entries: SpellcheckEntry[] = []

  for (const part of value.split(',')) {
    const item = part.trim()
    if (item === '') continue

    const enabled = !item.startsWith(DISABLED_DICTIONARY_PREFIX)
    const code = (enabled ? item : item.slice(DISABLED_DICTIONARY_PREFIX.length)).trim()
    if (code === '' || seen.has(code)) continue

    seen.add(code)
    entries.push({ code, enabled })
  }

  return entries
}

/** {@link SpellcheckEntry}[] → 清单串（保序）。 */
export function formatDictionaryList(entries: readonly SpellcheckEntry[]): string {
  return entries
    .map((entry) => (entry.enabled ? '' : DISABLED_DICTIONARY_PREFIX) + entry.code)
    .join(',')
}

/**
 * 清单串 → **参与检查**的那几门语言码（保序）—— 交给内核的就是它。
 *
 * 与 {@link parseDictionaryList} 分开，是为了让"停用"只有一个落点：要读清单的人要么要**完整**
 * 那一份（设置界面），要么要**交给内核**的那一份（拼写检查）。两种意图各有一个函数，就不会出现
 * "某处忘了滤掉停用的"。
 */
export function enabledLanguageCodes(value: string): string[] {
  return parseDictionaryList(value)
    .filter((entry) => entry.enabled)
    .map((entry) => entry.code)
}

/**
 * 保证清单里**至少有一门参与检查**：已经有一门启用的就原样返回，一门都没有时才把**第一项**打开。
 *
 * 为什么必须有：交给内核一个空清单等于"什么都不查"，而那与"拼写检查坏了"在用户看来没有区别
 * （[ADR-0070] 那条规则）。为什么打开第一项、而不是整体回落成默认值：后者会连着把用户排的次序与
 * 整份清单一起丢掉，看起来像"它自己变回去了"。
 *
 * 它是这条规则**唯一**的实现：{@link normalizeSpellcheckLanguages}（读设置那一刻）与对话框
 * 写回那一侧（草稿可以把唯一启用的那一门取消掉）都调它 —— 两处因此不会各自想出一种"至少要留一门"。
 */
export function ensureEnabledDictionary(entries: readonly SpellcheckEntry[]): SpellcheckEntry[] {
  if (entries.some((entry) => entry.enabled)) return [...entries]

  return entries.map((entry, index) => ({ code: entry.code, enabled: index === 0 }))
}

/**
 * 把 `code` 挪到 `target` 的**前面 / 后面**（[ADR-0087]）。
 *
 * 纯函数，因此能被单测 —— 这条路全是"看着差不多"的边界：往下拖与往上拖的插入点差一格、拖到自己
 * 身上、目标已经不在清单里，而它们**错一格都不会报错**，只会让人觉得"拖完了位置不对"。
 *
 * 先把被挪的那一项摘掉再算落点：两个方向因此共用同一段推理（"落在停下来的那张清单的第几个"）。
 */
export function moveDictionary(
  entries: readonly SpellcheckEntry[],
  code: string,
  target: string,
  after: boolean,
): SpellcheckEntry[] {
  const moved = entries.find((entry) => entry.code === code)
  if (moved === undefined || code === target) return [...entries]

  const rest = entries.filter((entry) => entry.code !== code)
  const at = rest.findIndex((entry) => entry.code === target)
  if (at === -1) return [...entries]

  const index = after ? at + 1 : at
  return [...rest.slice(0, index), moved, ...rest.slice(index)]
}

/**
 * 把 `code` 往前 / 往后挪**一格**（`delta` 是 `-1` 或 `1`）。
 *
 * 它是拖动的**键盘路径**（清单行 `⋯` 里的「上移 / 下移」）：一件只能用鼠标做的事，对不用鼠标的人
 * 等于不存在。已经到头时原样返回，调用点据此把那一项禁用。
 */
export function stepDictionary(
  entries: readonly SpellcheckEntry[],
  code: string,
  delta: -1 | 1,
): SpellcheckEntry[] {
  const from = entries.findIndex((entry) => entry.code === code)
  const to = from + delta
  if (from === -1 || to < 0 || to >= entries.length) return [...entries]

  const next = [...entries]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)

  return next
}

/** 把一个不可信的值收敛成一行合法的词典清单（读设置时用）。 */
export function normalizeSpellcheckLanguages(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SPELLCHECK_LANGUAGES

  const known = new Set(SPELLCHECK_LANGUAGES.map((entry) => entry.code))
  const kept = parseDictionaryList(value).filter((entry) => known.has(entry.code))

  // 一个都不剩（空串、或者全是我们不认识的值）时回落到默认 —— 空清单交给内核等于
  // "什么都不查"，而那与"功能坏了"在用户看来没有区别。
  return kept.length === 0
    ? DEFAULT_SPELLCHECK_LANGUAGES
    : formatDictionaryList(ensureEnabledDictionary(kept))
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
 * 把设置里的词典清单与内核实际支持的清单对账。
 *
 * `available` 由调用方从 `session.availableSpellCheckerLanguages` 取 —— 它是内核的事实，
 * 因此这个函数保持纯函数：给定同样的两个输入，结果就一样，可以单测。
 *
 * ⚠️ **被停用的那些不进来**（[ADR-0087]）：它们不参与检查，因此也不该出现在"内核没有这门词典"
 * 那条日志里 —— 那会把一条真正的缺词典埋在一批用户主动关掉的码里。
 */
export function resolveSpellcheckLanguages(
  requested: string,
  available: readonly string[],
): SpellcheckResolution {
  const supported = new Set(available)
  const applied: string[] = []
  const rejected: string[] = []

  for (const code of enabledLanguageCodes(requested)) {
    if (supported.has(code)) applied.push(code)
    else rejected.push(code)
  }

  return { applied, rejected }
}
