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
 *
 * ⚠️ 界面语言自 [ADR-0088] 起**又回来了**，但这次只做一件事、而且只**读**：让**首次**的词典清单
 * 跟随内嵌页面的界面语言（`wa_web_lang_pref`，判据见 {@link matchDictionaryLanguage} 与
 * {@link adoptInterfaceDictionary}）。这不是 [ADR-0066] 的反悔 —— 那时我们试图**改**页面的语言
 * （三轮都失败，最后一轮还撞在 INV-1 上），现在我们只是把它**读**出来选一门词典。
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
 * ⚠️ 它只是**起点**，不是终局：**首次**运行时（以及此后每次启动，只要清单还停留在这一门上）
 * [ADR-0088] 会用**内嵌页面的界面语言**那一门把它换掉（判据与实现在
 * {@link adoptInterfaceDictionary} 与 `main/page-language.ts`）。取代它的判据是"清单恰好只剩
 * 这一门" —— 用户一旦自己排过清单，这条路就永久让开（见那条函数上的说明）。
 *
 * 为什么不跟随**系统语言**：输入内容的语言与系统/界面的语言是两件事 —— 一台切到日语的机器上，
 * 用户照样可能在用英语打字。把两者绑在一起会得到"系统改了、拼写检查跟着变"这种没人要的联动，
 * 而联动本身**看不出来**，用户只会觉得拼写检查坏了。因此默认值写死，改由用户自己勾。
 * 内嵌页面的界面语言是另一回事：它由**账号**决定，说话的是"你这个人在用哪种语言"，而不是
 * "这台机器装的是哪个 locale"。
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

/**
 * 网页版记「界面语言」的那条 cookie 的名字（实测，`docs/research/lang-preference.md` §4.4）。
 *
 * ⚠️ 我们**只读**它，**从不写**（[ADR-0066]：写下的值会在 2–3 秒内被页面按账号语言改回去，
 * 而与它抢是 [ADR-0066] 已经否决过的做法）。名字放在这里而不是某个模块里，是因为它今天有
 * **两个**读者：只读探针（`main/dev-probe-lang.ts`，未打包时才装）与"词典默认值跟随界面语言"
 * 那条路（[ADR-0088]，`main/page-language.ts`）。两处各写一份的话，名字一改，探针会**静默地**
 * 什么都观察不到 —— 而它正是我们看清上游何时改版的唯一眼睛。
 */
export const PAGE_LANGUAGE_COOKIE = 'wa_web_lang_pref'

/**
 * 一个"看起来就是语言码"的形状（`zh_CN` / `en` / `pt_BR` / `zh-Hans-CN`）。
 *
 * 只有一个用途：**日志**。那条 cookie 的值可能是凭据（`docs/security.md` T4），因此只有这个形状
 * 的值才原样打出来，其余一律只报"认不出"。它与 `test/fixtures/probe-lang-pref.js` 里同名的那一条
 * **必须一致**（夹具不能 `import`，只能各写一份）—— 判据不同就会出现"主进程打了、页面没打"
 * 这种对不上的报告，改一处记得改另一处。
 */
export function isLanguageCode(value: string): boolean {
  return /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/.test(value)
}

/**
 * 网页版那条界面语言 cookie 的值 → {@link SPELLCHECK_LANGUAGES} 里的哪一门（[ADR-0088]）。
 *
 * 两段，先后顺序就是它们的重要性：
 *
 *   1. **先认区域**：把 `en_GB` 的 `_` 归一成 `-` 之后与表里的码逐字比（大小写不敏感）。命中就
 *      返回它 —— 界面是英式英语时，用得上的正是 `en-GB` 那一门，而不是表里排第一的 `en-US`；
 *   2. **再按基础语言落回表里的顺序**：`en_AU` / `pt_PT` / `de_DE` 这类我们没有的区域变体，
 *      取表里**第一门**同基础语言的（`en` → `en-US`，`pt` → `pt-BR`，`de` → `de`）。
 *      "表里的顺序"是判据的一部分，不是巧合：它是我们**没有任何偏好**时唯一的确定性来源。
 *
 * 都命中不了（`zh_CN` / `ja_JP`）返回 `null`。那是"我们这 24 门里没有这一门"，**不是错误** ——
 * 中文根本没有 Hunspell 词典（见 {@link SPELLCHECK_LANGUAGES}），而 `null` 的后果只是"清单保持
 * 原样"，不是"选了一门错的"。
 */
export function matchDictionaryLanguage(pageLanguage: string): string | null {
  const normalized = pageLanguage.trim().replace(/_/g, '-').toLowerCase()
  if (normalized === '') return null

  const exact = SPELLCHECK_LANGUAGES.find((entry) => entry.code.toLowerCase() === normalized)
  if (exact !== undefined) return exact.code

  const base = normalized.split('-')[0]
  const byBase = SPELLCHECK_LANGUAGES.find(
    (entry) => entry.code.split('-')[0]?.toLowerCase() === base,
  )

  return byBase?.code ?? null
}

/**
 * 词典清单要不要跟着内嵌页面的界面语言动一次；返回**要写回的那一串**，`null` = 什么都不做
 * （[ADR-0088]）。
 *
 * 纯函数，因为这条路上每一格出错都是安静的：多帮你选一门是"它自己又变回去了"，少一次是
 * "功能没做"，而**跟用户抢**（把他删掉的那门塞回去）是这三者里最糟的一种。
 *
 * @param requested 当前清单（设置里那一份，已过 {@link normalizeSpellcheckLanguages}）
 * @param dictionary {@link matchDictionaryLanguage} 的结果
 * @param onLanguageChange `true` = 这条 cookie **真的变了**（页面登录之后写下账号语言、或用户在
 *   手机上改了语言）；`false` = 启动时读到的那一次 —— 那时它是**上次**留下的值
 */
export function adoptInterfaceDictionary(
  requested: string,
  dictionary: string | null,
  onLanguageChange: boolean,
): string | null {
  // 界面语言在我们这 24 门里没有对应（中文、日语…）→ 一个字节都不动。
  if (dictionary === null) return null

  const entries = parseDictionaryList(requested)

  /**
   * 已经在清单里（**无论启不启用**）就不动它。
   *
   * ⚠️ 这一条同时是"不跟用户抢"那条纪律的落点：他刚把这一门从清单里删掉、或者取消了勾选，
   * 而界面语言并没有变 —— 我们没有任何理由把它塞回去（那正是 [ADR-0066] 那类"跟页面抢"的翻版）。
   */
  if (entries.some((entry) => entry.code === dictionary)) return null

  /**
   * 清单还**恰好**是 {@link DEFAULT_SPELLCHECK_LANGUAGES} 这一门：它是"用户从没定过"的最强判据
   * （他一旦动过，要么门数变了、要么开关变了），因此直接换掉 —— 这就是 [ADR-0088] 要取代的那件事。
   */
  const only = entries.length === 1 ? entries[0] : undefined
  if (only !== undefined && only.enabled && only.code === DEFAULT_SPELLCHECK_LANGUAGES) {
    return dictionary
  }

  /**
   * 剩下的只有"界面语言**刚刚**变了"那一次：把它补进清单的**第一位**（"首先和界面语言匹配的
   * 那一门"），其余一个字节都不动。
   *
   * 启动时那一次到此为止：拿**上次**的语言去改一份用户排过的清单，就是在跟用户抢。它也有副作用
   * 之外的第二个理由 —— 启动时页面还没跟服务端说过话，cookie 里那个值随时可能在几秒后被改掉。
   */
  if (!onLanguageChange) return null

  return formatDictionaryList([{ code: dictionary, enabled: true }, ...entries])
}
