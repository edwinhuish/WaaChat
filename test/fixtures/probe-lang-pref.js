/**
 * 只读探针：网页版的「界面语言」记在哪儿、**谁能写它**。
 *
 * 对应 `docs/research/lang-preference.md`。
 *
 * ── 它在回答什么 ───────────────────────────────────────────────────────────
 *
 * 背景：`wa_web_lang_pref` 这条 cookie 改掉就能换语言，但它**会被改回来**。在动手拦它之前
 * 必须先分清是哪一种"被改回来" —— 两者的手段完全不同：
 *
 *   - **形态 A：网络响应写它**（`Set-Cookie`）⇒ 可以在会话层拦响应头；
 *   - **形态 B：页面脚本写它**（`document.cookie`，或从页面存储读回来再写）⇒ 拦响应头没用，
 *     而要拦住脚本就只剩注入，那违反 [INV-1]。**形态 B 没有干净的解法。**
 *
 * 本探针只看**页面这一侧**，三条合起来才能定性：
 *
 *   1. `document.cookie` 里**看不看得见**它 —— 看不见 ⇒ 它是 HttpOnly ⇒ 只可能是网络写的。
 *      ⚠️ 反过来不成立：看不见也可能只是**还没被写过**（页面刚装载时）。所以主进程那一侧的
 *      日志（`src/main/dev-probe-lang.ts`）必须一起看。
 *   2. 页面存储（localStorage / sessionStorage / IndexedDB 的**库名**）里有没有语言键
 *      —— 有，就说明"拦住网络也拦不住页面自己写回"。
 *   3. `navigator.language` / `navigator.languages` / `Intl` 的取值 —— 与启动期的 `--lang`
 *      对照，验证 [ADR-0063] 那条链路还在（上游挑语言包挑的是不是这一个值）。
 *
 * **它不回答**"服务端有没有发 `Set-Cookie`"：那要在主进程看。两边**必须一起看**。
 *
 * ── 纪律（务必保持）────────────────────────────────────────────────────────
 *
 * - **只读**：只读 cookie / 存储 / `navigator`，不写任何东西、不发请求、不改页面
 *   （[INV-1] 的只读例外，[ADR-0057]）。因此**不要**在这里加"顺手改一下再 reload"这类便利
 *   方法 —— 一旦能**写**，它就不再是只读例外覆盖的那段代码了。
 * - **cookie 只报名字**，且只有**看起来就是语言码**的值才原样报出，其余一律只报长度：同一个
 *   cookie 串里躺着会话凭据（`wa_ul` 之类），打印它就是泄漏。
 * - `location` 只报**参数名**与 `lang` 的值：别的 query 里可能有凭据。
 * - 不进 IndexedDB 里面读：库里是消息内容，不是元数据。
 *
 * ── 怎么跑 ─────────────────────────────────────────────────────────────────
 *
 * **开发模式（推荐）**：`pnpm run dev` 时 `src/main/dev-probe.ts` 会把它装进承载上游页面的
 * 窗口（只在未打包时），页面加载完自动取一次快照。之后：
 *
 *   1. Ctrl+Shift+I → Console
 *   2. `await __waLangPref.refresh()`  重新取一次快照（改了语言、或过一会儿再看时用）
 *   3. `__waLangPref.report()`         把报告整段复制出来
 *
 * **手动粘贴**（任何环境，含打包产物）：`cat test/fixtures/probe-lang-pref.js` 整段贴进 Console。
 *
 * ⚠️ 为什么要"过一会儿再看"：服务端把 cookie 改回来多半发生在一次会话同步或一段空闲之后，
 * 页面刚装载完的那一瞬间看不出任何东西。
 */

;(() => {
  const CFG = {
    /** 网页版记界面语言的那条 cookie。 */
    cookieName: 'wa_web_lang_pref',
    /** 页面存储里"可能放语言"的键名判据。**只报键名**，值的规则见 {@link describeValue}。 */
    keyPattern: /lang|locale|i18n|language|pref/i,
    /** 每个 storage 最多看多少个键（防着某天它有几万个键）。 */
    maxKeys: 500,
  }

  /**
   * "看起来就是语言码"的判据：`zh-CN` / `en` / `pt_BR` / `zh-Hans-CN`。
   *
   * ⚠️ 与 `src/main/dev-probe-lang.ts` 里同名的那一条**必须一致**：两边各自在算"这个值能不能
   * 原样打印"，判据不同就会出现"主进程打了、页面没打"这种对不上的报告。夹具不能 `import`
   * （它要能被整段粘贴进控制台），所以只能各写一份 —— **改一处记得改另一处**。
   */
  const LANGUAGE_CODE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/

  /** 值 → 可打印的形状。**只有语言码原样报出**，其余一律只报长度。 */
  function describeValue(value) {
    if (typeof value !== 'string') return `type=${typeof value}`
    return LANGUAGE_CODE.test(value) ? value : `len=${value.length}`
  }

  /** `document.cookie` 是 `a=1; b=2` 的形状 —— 只切出**名字**，值一律丢掉。 */
  function cookieNames(header) {
    return String(header ?? '')
      .split(';')
      .map((part) => {
        const at = part.indexOf('=')
        return (at === -1 ? part : part.slice(0, at)).trim()
      })
      .filter((name) => name !== '')
  }

  /** 从同一个 cookie 串里取某一条的值（取不到返回 `null`）。 */
  function cookieValue(header, name) {
    for (const part of String(header ?? '').split(';')) {
      const at = part.indexOf('=')
      if (at === -1) continue
      if (part.slice(0, at).trim() !== name) continue
      return part.slice(at + 1).trim()
    }
    return null
  }

  /** 一个 storage 里"疑似语言键"的清单。只报键名与规范化后的值。 */
  function readStorage(storage) {
    const keys = []
    let total = 0
    let error = null

    try {
      total = typeof storage?.length === 'number' ? storage.length : 0

      for (let index = 0; index < Math.min(total, CFG.maxKeys); index += 1) {
        const key = storage.key(index)
        if (typeof key !== 'string' || !CFG.keyPattern.test(key)) continue

        let value
        try {
          value = storage.getItem(key)
        } catch {
          value = undefined
        }

        keys.push({ key, value: describeValue(value) })
      }
    } catch (caught) {
      error = caught?.name ?? 'Error'
    }

    return { total, keys, error }
  }

  /** IndexedDB 只报**库名**：库里是消息内容，不属于本探针的范围（也不该读）。 */
  async function readDatabaseNames() {
    const idb = window.indexedDB
    if (!idb || typeof idb.databases !== 'function') return { names: null, error: null }

    try {
      const databases = await idb.databases()

      return {
        names: databases
          .map((database) => String(database?.name ?? ''))
          .filter((name) => name !== ''),
        error: null,
      }
    } catch (caught) {
      return { names: null, error: caught?.name ?? 'Error' }
    }
  }

  /**
   * 当前地址。
   *
   * 只留**参数名**，外加 `lang` 的值 —— `?lang=` 是"上游认不认这个参数"那一问的入口，
   * 而其它 query 里可能有凭据（见文件头的纪律）。
   */
  function readLocation() {
    const location = window.location
    const names = []
    const details = {}

    try {
      for (const [name, value] of new URLSearchParams(String(location?.search ?? ''))) {
        if (names.includes(name)) continue

        names.push(name)
        if (name === 'lang') details[name] = describeValue(value)
      }
    } catch (caught) {
      return {
        origin: String(location?.origin ?? ''),
        path: String(location?.pathname ?? ''),
        names,
        details,
        error: caught?.name ?? 'Error',
      }
    }

    return {
      origin: String(location?.origin ?? ''),
      path: String(location?.pathname ?? ''),
      names,
      details,
      error: null,
    }
  }

  /** `Intl` 认下来的 locale —— 取不到就报 `null`：比报一个猜出来的值好。 */
  function readIntlLocale() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().locale
    } catch {
      // 某些上下文里 Intl 可能不可用；这不是错误，只是这一条没测到。
      return null
    }
  }

  /** 上游挑语言包时真正看的那些值（[ADR-0063]）。 */
  function readNavigator() {
    const navigator = window.navigator

    return {
      language: String(navigator?.language ?? ''),
      languages: Array.isArray(navigator?.languages) ? navigator.languages.map(String) : [],
      intl: readIntlLocale(),
    }
  }

  async function snapshot() {
    let cookieHeader = ''
    let cookieError = null

    try {
      cookieHeader = String(window.document?.cookie ?? '')
    } catch (caught) {
      cookieError = caught?.name ?? 'Error'
    }

    const target = cookieValue(cookieHeader, CFG.cookieName)

    return {
      at: new Date().toISOString(),
      location: readLocation(),
      navigator: readNavigator(),
      cookie: {
        scriptVisible: target !== null,
        value: target === null ? null : describeValue(target),
        names: cookieNames(cookieHeader),
        error: cookieError,
      },
      storage: {
        local: readStorage(window.localStorage),
        session: readStorage(window.sessionStorage),
        databases: await readDatabaseNames(),
      },
    }
  }

  /**
   * 自动判定。
   *
   * 每一句都必须**同时**进控制台与 `report()`：这份报告是唯一会被整段贴出来给人看的东西，
   * 漏掉任何一句限定条件（尤其是"这一条判据本次不成立"）都会让人从报告里得出错误结论。
   */
  function verdicts(data) {
    const lines = []

    if (data.cookie.error) {
      lines.push(
        `⚠️ 读不到 document.cookie（${data.cookie.error}）⇒ 这一条判据本次不成立，别从它推结论。`,
      )
    } else if (data.cookie.scriptVisible) {
      lines.push(
        `cookie：脚本**看得见**它（= ${data.cookie.value}）⇒ 它**不是** HttpOnly。` +
          '这既可能是网络响应写的（只是没打 HttpOnly），也可能是页面自己写的 ——' +
          '**回去看主进程日志**里 `lang probe: cookie changed` 的 cause：' +
          'explicit = 页面脚本写的（形态 B）；overwrite / 其它 = 网络写回来的（形态 A）。',
      )
    } else {
      lines.push(
        'cookie：脚本**看不到**它。两种可能：① 它是 HttpOnly ⇒ 只可能由网络响应写入 ⇒ 形态 A；' +
          '② 此刻还没被写过（页面刚装载时很常见）。**回去看主进程日志**：只要那里出现过 ' +
          'httpOnly: true，就是①。',
      )
    }

    const languageKeys = [...data.storage.local.keys, ...data.storage.session.keys]
    if (languageKeys.length === 0) {
      lines.push(
        '页面存储：本次扫描**没有**找到疑似语言键 ⇒ 没有"页面自己写回"的证据（形态 B 未证实）。',
      )
    } else {
      const sameAsCookie = languageKeys.filter((entry) => entry.value === data.cookie.value)
      lines.push(
        `页面存储：找到 ${languageKeys.length} 个疑似语言键（${languageKeys
          .map((entry) => entry.key)
          .join('、')}）⇒ **拦住网络响应未必够**：页面可能从存储里读回来再写一次。` +
          (data.cookie.scriptVisible && sameAsCookie.length > 0
            ? `⚠️ 其中 ${sameAsCookie.map((entry) => entry.key).join('、')} 的值与 cookie 的**相同**。`
            : ''),
      )
    }

    if (data.storage.databases.error) {
      lines.push(`IndexedDB：列不了库名（${data.storage.databases.error}）—— 这一条本次没测到。`)
    } else if (data.storage.databases.names === null) {
      lines.push('IndexedDB：这个上下文没有 `indexedDB.databases()` —— 这一条本次没测到。')
    } else {
      const names = data.storage.databases.names
      lines.push(
        `IndexedDB：${names.length} 个库${names.length ? `（${names.slice(0, 6).join('、')}${names.length > 6 ? '…' : ''}）` : ''}。` +
          '⚠️ 本探针**不进去读**：库里是消息内容。要查语言是否也存在库里，先想清楚值不值得（另立一条）。',
      )
    }

    lines.push(
      `navigator.language = ${data.navigator.language}；languages = ${data.navigator.languages.join(', ')}；` +
        `Intl = ${data.navigator.intl} —— 与启动期的 --lang 对照（[ADR-0063]）。`,
    )

    if (data.location.names.length === 0) {
      lines.push(
        'query 参数：无。**`?lang=` 那一问还没测**：在普通浏览器里打开 ' +
          'https://web.whatsapp.com/?lang=ja-JP 看登录页是不是日语（不登录、不改任何状态，零风险）。',
      )
    } else {
      const lang = data.location.details['lang']
      lines.push(
        `query 参数名：${data.location.names.join('、')}${lang ? `；lang = ${lang}` : ''}` +
          '（`?lang=` 那一问见文件头与 docs/research/lang-preference.md）。',
      )
    }

    return lines
  }

  function storageLines(title, storage) {
    const keys = storage.keys.map((entry) => `${entry.key} = ${entry.value}`)
    const detail = storage.error
      ? `（读不到：${storage.error}）`
      : `疑似语言键 ${storage.keys.length} 个${keys.length ? ` —— ${keys.join('；')}` : ''}`

    return `- ${title}：${storage.total} 个键，${detail}`
  }

  /** 报告是给人**整段复制**的：纯文本，贴进任何窗口都还能读。 */
  function text(data) {
    if (data === null) {
      return '# 界面语言探针（页面侧）\n\n还没取过快照：先 `await __waLangPref.refresh()`。'
    }

    return [
      '# WaaChat 界面语言探针报告（页面侧）',
      '',
      `生成时间：${data.at}`,
      `页面：${data.location.origin}${data.location.path}`,
      '',
      '## 结论（自动判定）',
      ...verdicts(data).map((line) => `- ${line}`),
      '',
      '## cookie（只报名字，不报值）',
      `- 脚本可见的 cookie：${data.cookie.names.length} 个 —— ${
        data.cookie.names.join('、') || '（一个都没有）'
      }`,
      `- ${CFG.cookieName}：${
        data.cookie.scriptVisible
          ? `可见（值 ${data.cookie.value}）`
          : '不可见（HttpOnly，或者此刻还没被写过）'
      }`,
      '',
      '## 页面存储（只报键名；值只有"看起来就是语言码"才原样报出）',
      storageLines('localStorage', data.storage.local),
      storageLines('sessionStorage', data.storage.session),
      '',
      '⚠️ 以上只是**页面侧**的一半：服务端有没有发 `Set-Cookie`、cookie 每次变化的原因，都在',
      '主进程日志里（`lang probe:` 那几行）。两边一起看才能定性。',
    ].join('\n')
  }

  /**
   * 状态必须留在 `window` 上（而不是闭包里）：开发模式注入只求值一次，之后每次调用
   * `__waLangPref.*` 都不会重新求值本文件。
   */
  const state = (window.__waLangPref ??= { last: null })

  state.refresh = async () => {
    try {
      state.last = await snapshot()
    } catch (caught) {
      console.warn(
        `[语言探针] 取快照失败（${caught?.name ?? 'Error'}）：报告里会保留上一次的快照。`,
      )
      return state.last
    }

    console.info('[语言探针] 快照已更新。结论：')
    verdicts(state.last).forEach((line) => console.info(`  · ${line}`))

    return state.last
  }

  /** 报告（纯文本，可整段复制）。没取过快照时返回一句提示而不是抛错。 */
  state.report = () => text(state.last)

  /**
   * 把报告放进剪贴板。与媒体探针同款：无论成败都把报告**返回** —— 被拒时再手工复制一次就行。
   */
  state.copy = () => {
    const report = state.report()
    const clipboard = window.navigator?.clipboard

    if (typeof clipboard?.writeText !== 'function') {
      console.warn('[语言探针] 这个上下文没有 navigator.clipboard：请直接复制 report() 的返回值。')
      return report
    }

    clipboard.writeText(report).then(
      () => console.info(`[语言探针] 报告已进剪贴板（${report.length} 个字符）。`),
      (error) =>
        console.warn(
          `[语言探针] 写剪贴板失败（${error?.name ?? 'Error'}）：请直接复制 report() 的返回值。`,
        ),
    )

    return report
  }

  // 装完就取一次：读 cookie / 存储 / navigator 不依赖上游是否就绪，因此不存在媒体探针
  // 那种"上游 store 还没起来"的假警报（那个因此有 bootstrap 标记，这个不需要）。
  void state.refresh()

  console.info(
    '[语言探针] 已装载（页面侧）。可用：__waLangPref.refresh() / report() / copy()' +
      ' —— 服务端那一半在主进程日志里（lang probe:）。',
  )
})()
