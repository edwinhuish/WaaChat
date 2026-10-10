/**
 * 只读探针：WA Web **客户端侧**的媒体元数据里到底有什么。
 *
 * 对应 docs/research/early-file-identity.md 的 P1–P4。
 *
 * 它不是应用代码，而是要**在页面主世界里求值**的一段脚本，所以必须自包含
 * （有任何一个 `import` 就没法粘贴、也没法注入）。它由 `test/unit/probe-media-metadata.test.ts`
 * 读取源码后求值来验证 —— 那个测试守着两条不能靠人记住的性质：**绝不打印密钥值**、
 * **必须走原型链上的 getter**。
 *
 * 位置说明：放在 `test/fixtures/` 而不是 `src/` —— 它的宿主是**浏览器**不是 Node，
 * 因此 `eslint.config.mjs` 给它的是 browser globals（见 `PAGE_CONTEXT_FIXTURE`）。
 *
 * ── 怎么跑（推荐）─────────────────────────────────────────────────────────
 * **开发模式下不需要手动粘贴**：`pnpm run dev` 时 `src/main/dev-probe.ts` 会在页面加载后
 * 把本文件自动装进聊天窗口（只在未打包时）。然后：
 *   1. Ctrl+Shift+I → Console（src/ 里没有 setApplicationMenu，Electron 默认菜单还在）
 *   2. __waProbe.scan()    在当前会话里扫一次
 *   3. __waProbe.report()  ← 把返回值整段复制出来给人看（__waProbe.copy() 会顺手进剪贴板）
 *
 * 自动装载**只装 API、不立刻扫描**：页面刚加载完时上游的 store 往往还没起来，那时扫描会把
 * "没找到消息集合"这条**假警报**打出来（它在粘贴流程里是一条真诊断）。
 *
 * 手动粘贴（任何环境都可用，含打包产物）：`cat test/fixtures/probe-media-metadata.js`
 * 整个粘进 Console。粘贴与注入的唯一区别是粘贴会**立即扫描一次**。
 *
 * ── P2 / P3 怎么用（跨会话比较）────────────────────────────────────────────
 * WA Web 是单页应用，切聊天不刷新页面，所以 window.__waProbe 会跨会话存活：
 *   a. 在会话 A 里发送/查看那个文件 → __waProbe.scan() → __waProbe.capture('A')
 *   b. 切到会话 B，把**同一个文件**再发一次（P3 可以先改个名字再发）
 *      → ⚠️ **必须再 scan 一次**：capture 记录的是"上一次扫描到的消息"，
 *         切会话本身不会更新它。忘了重扫 ⇒ 两个通道记的是同一条消息 ⇒ P2 得出**错误**结论。
 *      → __waProbe.capture('B')
 *   c. 比较：__waProbe.compare()
 *      → 指纹相同 = 这个字段标识的是「内容」；不同 = 只是「对象」
 *   d. 收尾：__waProbe.report()（或 .copy()）
 *
 * ── 纪律（务必保持）──────────────────────────────────────────────────────
 * - 只读：不下载、不建 Blob、不发请求、不修改任何东西。
 * - 不读密钥：mediaKey 之类只报「长度」，绝不取值、绝不打印。
 * - filehash 是对**密文**做的 HMAC（macKey 由 mediaKey 经 HKDF 派生），属 INV-3 范围。
 *   默认**不**计算它的指纹。只有 P1 表明"客户端侧没有 fileSha256、只有 filehash"时，
 *   才把 CFG.fingerprintKeyDerived 改成 true 再跑一次 —— 那是为了确认岔路口存在，不是实现。
 * - 报告里出现的一切（字段名、类型、长度、指纹前缀）都不是值：report() 之所以能整段贴出来，
 *   前提就是这条纪律没被破。
 */

;(() => {
  const CFG = {
    /** INV-3：默认不碰密钥派生的 filehash。见文件头。 */
    fingerprintKeyDerived: false,
    /** 每个会话最多扫多少条消息。 */
    maxMessages: 400,
  }

  // ---------------------------------------------------------------------
  // 值描述：**只报类型与长度**，不报内容。这样不可能把密钥泄漏到控制台。
  // ---------------------------------------------------------------------

  const FINGERPRINTABLE = new Set(['fileSha256', 'fileEncSha256'])
  const KEY_DERIVED = new Set(['filehash'])

  function describe(value) {
    if (value === null) return { kind: 'null', detail: '' }
    if (value === undefined) return { kind: 'undefined', detail: '' }

    const type = typeof value
    if (type === 'number' || type === 'boolean') return { kind: type, detail: String(value) }
    if (type === 'string') return { kind: 'string', detail: `len=${value.length}` }
    if (type === 'function') return { kind: 'function', detail: '' }

    if (value instanceof Uint8Array) return { kind: 'bytes', detail: `len=${value.length}` }
    if (value instanceof ArrayBuffer) return { kind: 'bytes', detail: `len=${value.byteLength}` }
    if (Array.isArray(value)) return { kind: 'array', detail: `len=${value.length}` }

    if (type === 'object') return { kind: 'object', detail: value.constructor?.name ?? '' }
    return { kind: type, detail: '' }
  }

  const toBytes = (value) => {
    if (value instanceof Uint8Array) return value
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    if (Array.isArray(value)) return Uint8Array.from(value)
    return null
  }

  /** 指纹只是用来判断「两次是不是同一个值」，不含任何可还原信息。 */
  function fingerprint(value) {
    const bytes = toBytes(value)
    if (bytes) {
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 12)

      return `len=${bytes.length} ${hex}`
    }
    if (typeof value === 'string') return `len=${value.length} ${value.slice(0, 12)}`
    return null
  }

  /**
   * 报告是给人**整段复制**的，所以表格必须是文本 —— `console.table` 的对象拷贝不出形状。
   * 用 markdown 表：贴进任何聊天窗口都还是表。
   */
  function markdownTable(headers, rows) {
    const cell = (value) => String(value ?? '').replace(/\|/g, '\\|')
    return [
      `| ${headers.map(cell).join(' | ')} |`,
      `|${headers.map(() => '---').join('|')}|`,
      ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
    ].join('\n')
  }

  // ---------------------------------------------------------------------
  // 找到消息集合：不假设只有一条路（上游版本差异大），并把「哪条路通了」也当数据点。
  // ---------------------------------------------------------------------

  function resolveMsgCollection() {
    const tried = []
    const candidates = [
      ['window.require("WAWebCollections").Msg', () => window.require?.('WAWebCollections')?.Msg],
      ['window.Store.Msg', () => window.Store?.Msg],
      ['window.require("WAWebMsgCollection")', () => window.require?.('WAWebMsgCollection')],
    ]

    for (const [label, get] of candidates) {
      try {
        const collection = get()
        const usable =
          collection &&
          (typeof collection.getModelsArray === 'function' ||
            Array.isArray(collection.models) ||
            typeof collection.get === 'function')

        if (usable) return { collection, label, tried: [...tried, `${label} ✓`] }
        tried.push(`${label} ✗`)
      } catch (error) {
        tried.push(`${label} ✗ (${error?.name ?? 'Error'})`)
      }
    }

    return { collection: null, label: null, tried }
  }

  function listMessages(collection) {
    try {
      if (typeof collection.getModelsArray === 'function') return collection.getModelsArray()
    } catch {
      /* 换下一条路 */
    }
    try {
      if (Array.isArray(collection.models)) return collection.models
    } catch {
      /* 放弃 */
    }
    return []
  }

  /** 媒体的形状只可能在两三个地方，逐个试。 */
  function mediaOf(msg) {
    if (msg?.mediaData) return { path: 'mediaData', value: msg.mediaData }
    if (msg?.mediaObject) return { path: 'mediaObject', value: msg.mediaObject }

    if (typeof msg?.get === 'function') {
      try {
        const value = msg.get('mediaData')
        if (value) return { path: 'msg.get("mediaData")', value }
      } catch {
        /* 放弃 */
      }
    }

    return null
  }

  /**
   * 枚举一个对象的字段形状。own properties 之外**必须**走原型链上的 getter ——
   * WA Web 的模型大量使用 `get` 访问器，只看 own keys 会漏掉关键字段。
   */
  function shapeOf(target) {
    const shape = new Map()

    const record = (name, value) => {
      if (name === 'constructor' || name.startsWith('_')) return
      shape.set(name, describe(value))
    }

    for (const name of Object.getOwnPropertyNames(target)) {
      const descriptor = Object.getOwnPropertyDescriptor(target, name)
      let value
      try {
        value = descriptor?.get ? target[name] : descriptor?.value
      } catch {
        value = undefined
      }
      record(name, value)
    }

    let proto = Object.getPrototypeOf(target)
    let depth = 0
    while (proto && proto !== Object.prototype && depth < 4) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (shape.has(name)) continue
        const descriptor = Object.getOwnPropertyDescriptor(proto, name)
        if (!descriptor?.get) continue
        let value
        try {
          value = target[name]
        } catch {
          value = undefined
        }
        record(name, value)
      }
      proto = Object.getPrototypeOf(proto)
      depth += 1
    }

    return shape
  }

  const extensionOf = (filename) => {
    if (typeof filename !== 'string') return null
    const match = /(\.[A-Za-z0-9]{1,8})$/.exec(filename)
    return match ? match[1] : null
  }

  /**
   * 文件名挂在哪，**不能假设**。上一个版本只读 `msg.filename`，实测两个通道都报 null，
   * 于是 P3 的"改名"情形从未被覆盖，元信息行却谎称覆盖了。逐个来源试，并记下**来源**
   * —— ⚠️ 只记来源与扩展名，绝不记录文件名本身（`docs/security.md` 的日志纪律）。
   */
  function filenameSource(message, mediaValue) {
    const candidates = [
      ['media.value.filename', mediaValue?.filename],
      ['media.value.name', mediaValue?.name],
      ['msg.filename', message?.filename],
      ['msg.mediaData.filename', message?.mediaData?.filename],
    ]

    for (const [label, value] of candidates) {
      if (typeof value === 'string' && value) return { label, value }
    }

    return { label: null, value: null }
  }

  // ---------------------------------------------------------------------
  // 状态：**必须**留在 window 上（而不是闭包里）—— 开发模式注入只求值一次，
  // 之后每次调用 __waProbe.* 都不再重新求值本文件。
  // ---------------------------------------------------------------------

  const state = (window.__waProbe ??= {
    runs: [],
    captured: {},
    lastScan: null,
    lastGoodScan: null,
    lastCompare: null,
  })

  // ---------------------------------------------------------------------
  // 主流程：扫描当前已加载的会话
  // ---------------------------------------------------------------------

  function scan() {
    /**
     * 每一句结论都必须**同时**进控制台与 report()：报告是唯一会被整段贴出来给人看的东西，
     * 漏掉任何一句（尤其是"这次没比过""扩展名没拿到"这类**限定条件**）都会让人从报告里
     * 得出错误结论。因此这里不直接调 console。
     */
    const notes = []
    const say = (level, text) => {
      notes.push(text)
      if (level === 'warn') console.warn(`[探针] ${text}`)
      else console.info(`[探针] ${text}`)
    }

    const at = new Date().toISOString()
    const { collection, label, tried } = resolveMsgCollection()

    if (!collection) {
      say('warn', '没找到消息集合。试过的路径：')
      tried.forEach((line) => console.warn('   ', line))
      say('warn', '这本身就是一个结论：上游把这个内部结构换了位置。请把它记下来。')
      say(
        'warn',
        '顺手在同一个控制台里再跑这两条，连输出一起贴回来（用来定位新的入口）：\n' +
          '   Object.keys(window).filter((k) => /require|Store|webpack/i.test(k))\n' +
          '   Object.keys(window).filter((k) => /^webpackChunk/.test(k))',
      )
      state.lastScan = { ok: false, at, label: null, messages: 0, mediaCount: 0, notes }
      return { ok: false, label: null, messages: 0, mediaCount: 0 }
    }

    const messages = listMessages(collection).slice(-CFG.maxMessages)
    const keyIndex = new Map() // 字段名 → { count, kinds, types, sample }
    const byType = new Map() // 消息类型 → 字段名集合
    let mediaCount = 0
    let lastMedia = null

    for (const msg of messages) {
      const media = mediaOf(msg)
      if (!media) continue

      mediaCount += 1
      lastMedia = { msg, media }

      const type = String(msg?.type ?? 'unknown')
      const typeKeys = byType.get(type) ?? new Set()
      byType.set(type, typeKeys)

      for (const [name, info] of shapeOf(media.value)) {
        typeKeys.add(name)

        const entry = keyIndex.get(name) ?? { count: 0, kinds: new Set(), types: new Set() }
        entry.count += 1
        entry.kinds.add(`${info.kind}${info.detail ? `(${info.detail})` : ''}`)
        entry.types.add(type)
        keyIndex.set(name, entry)
      }
    }

    state.lastMedia = lastMedia
    state.runs.push({ at, label, mediaCount, messages: messages.length })
    /** 第几次扫描产生了 current 的 lastMedia —— capture 靠它判断"有没有忘掉重扫"。 */
    state.lastScanRun = state.runs.length

    say('info', `消息集合来自：${label}`)
    say(
      'info',
      `扫了 ${messages.length} 条消息，其中 ${mediaCount} 条带媒体` +
        (mediaCount ? `；类型：${[...byType.keys()].join(', ')}` : ''),
    )

    if (!mediaCount) {
      say('warn', '当前会话里没有带媒体的消息。请先打开一个含有图片/视频/文档/语音的会话再扫一次。')
      say(
        'warn',
        '如果这个会话明明有媒体，那说明媒体字段是**懒加载**的 —— 把那个文件点开一次（或点一次下载）\n' +
          '        再重扫。⚠️ "字段要到点了才出现" 本身就是要记录的数据点：它决定能不能"下载前"拿到标识。',
      )
      state.lastScan = {
        ok: false,
        at,
        label,
        messages: messages.length,
        mediaCount: 0,
        rows: [],
        byType: [],
        notes,
      }
      return { ok: false, label, messages: messages.length, mediaCount: 0 }
    }

    // ---- P1 / P4：字段清单（按出现次数排序）----
    const rows = [...keyIndex.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, info]) => ({
        字段: name,
        出现: `${info.count}/${mediaCount}`,
        类型: [...info.kinds].slice(0, 2).join(' | '),
        消息类型: [...info.types].join(','),
        明文哈希: FINGERPRINTABLE.has(name) ? '★' : '',
        密钥派生: KEY_DERIVED.has(name) ? '⚠ INV-3' : '',
      }))

    console.table(rows)

    const byTypeCounts = [...byType.entries()].map(([type, keys]) => [type, keys.size])
    console.info('[探针] P4 逐类型字段数：', Object.fromEntries(byTypeCounts))
    notes.push(
      `P4 逐类型字段数：${byTypeCounts.map(([type, size]) => `${type}=${size}`).join(' ')}`,
    )

    // ---- 结论行：这是这个探针存在的唯一目的 ----
    const keys = [...keyIndex.keys()]
    const hasPlainSha = keys.some((name) => /sha256/i.test(name) && !/enc/i.test(name))
    const hasEncSha = keys.some((name) => /encsha256/i.test(name))
    const hasFileHash = keys.some((name) => /^filehash$/i.test(name))
    const hasMediaKey = keys.some((name) => /mediakey/i.test(name))

    console.group('[探针] P1 结论')
    say('info', `明文 SHA-256 字段（fileSha256 或等价物）：${hasPlainSha ? '✓ 有' : '✗ 没有'}`)
    say('info', `密文 SHA-256 字段（fileEncSha256）：      ${hasEncSha ? '✓ 有' : '✗ 没有'}`)
    say('info', `密钥派生的 filehash：                    ${hasFileHash ? '✓ 有' : '✗ 没有'}`)
    say('info', `mediaKey（只报了长度，没取值）：          ${hasMediaKey ? '✓ 有' : '✗ 没有'}`)
    say(
      'info',
      hasPlainSha
        ? '→ 走方案 B：下载前就能拿到内容哈希，**不需要**动 INV-3。下一步做 P2（跨会话比较）。'
        : hasFileHash
          ? '→ ⚠️ 客户端侧只有 filehash（密钥派生）。要么退回方案 A，要么必须先就 INV-3 立一条 ADR。'
          : '→ ⚠️ 两个都没有：说明客户端把哈希藏在别的结构里，或字段名不同。把报告一起看。',
    )
    console.groupEnd()

    state.lastScan = {
      ok: true,
      at,
      label,
      messages: messages.length,
      mediaCount,
      rows,
      byType: byTypeCounts,
      notes,
    }
    state.lastGoodScan = state.lastScan

    return { ok: true, label, messages: messages.length, mediaCount }
  }

  /** 扫描当前会话。**必须**挂上去：它是"重扫"的唯一入口（见文件头的 P2 步骤）。 */
  state.scan = scan

  /**
   * 上游就绪了吗（只读、不打印）。
   *
   * 存在的理由：开发模式注入发生在 `did-finish-load`，那时上游的 store 常常还没起来。
   * 由注入方轮询本方法、就绪后再调 scan()，就不会把"找不到消息集合"这条**假警报**打出来。
   */
  state.ready = () => resolveMsgCollection().collection !== null

  // ---------------------------------------------------------------------
  // P2 / P3：跨会话比较
  // ---------------------------------------------------------------------

  state.capture = (channel) => {
    const target = state.lastMedia
    if (!target) {
      console.warn('[探针] 还没扫到带媒体的消息，先在有媒体的会话里 scan() 一次。')
      return
    }

    const { msg, media } = target
    const shape = shapeOf(media.value)
    const picked = {}

    for (const name of shape.keys()) {
      const isWanted =
        FINGERPRINTABLE.has(name) || (CFG.fingerprintKeyDerived && KEY_DERIVED.has(name))
      if (!isWanted) continue

      let value
      try {
        value = media.value[name]
      } catch {
        value = undefined
      }
      picked[name] = fingerprint(value)
    }

    const { label: nameFrom, value: filename } = filenameSource(msg, media.value)

    const captured = {
      消息类型: String(msg?.type ?? 'unknown'),
      扩展名: extensionOf(filename),
      扩展名来源: nameFrom,
      字段数: shape.size,
      指纹: picked,
      警告: null,
    }

    /**
     * 忘了重扫就 capture，两个通道会记下**同一条消息** —— 于是 compare() 会报"指纹相同"，
     * 而 P2 的结论正好相反（那个字段其实只标识对象）。这是**静默的错误结论**，
     * 比报错更糟，所以这里必须出声，而且必须**进报告**（否则贴出来的人看不到这个前提）。
     */
    if (state.capturedInRun === state.lastScanRun) {
      captured.警告 =
        '自上次扫描以来没有重新扫描过：本次 capture 取的是"上一次扫描到的消息"，' +
        `通道 "${channel}" 与上一个通道可能是同一条消息，compare() 会给出**错误**的结论。`
      console.warn(`[探针] ⚠️ ${captured.警告}`)
    }

    state.captured[channel] = captured

    state.capturedInRun = state.lastScanRun
    console.info(`[探针] 已记录通道 "${channel}"：`, captured)
    return captured
  }

  state.compare = () => {
    /** 同 scan()：每一句判定都要进报告。 */
    const notes = []
    const say = (level, text) => {
      notes.push(text)
      if (level === 'warn') console.warn(`[探针] ${text}`)
      else console.info(`[探针] ${text}`)
    }
    const record = (a, b, rows) => {
      state.lastCompare = { a, b, rows, notes }
    }

    const channels = Object.keys(state.captured)
    if (channels.length < 2) {
      say('warn', '至少 capture 两个通道再比较（见文件头的 P2 步骤）。')
      record(null, null, [])
      return
    }

    const [a, b] = channels
    const names = new Set([
      ...Object.keys(state.captured[a].指纹),
      ...Object.keys(state.captured[b].指纹),
    ])

    /**
     * ⚠️ 这是本探针最容易产出的**静默错误结论**：指纹集合为空 ⇒ 下面的 rows 也为空 ⇒
     * "没有任何字段跨会话相同"会被当成一条结论打印出来，而我们**一个字段都没比过**。
     * 实测就发生过：客户端侧既没有 fileSha256、也没有 fileEncSha256，picked 是 `{}`。
     */
    if (names.size === 0) {
      say(
        'warn',
        '一个字段都没进入比较 —— 这不是"跨会话都不同"，而是**根本没比**。\n' +
          '        原因通常是两个通道的指纹集合都为空：客户端侧没有明文/密文 SHA-256。\n' +
          '        若 P1 显示只有 filehash（密钥派生），可把 CFG.fingerprintKeyDerived 改成 true 再扫一次 ——\n' +
          '        但那是 INV-3 范围，动手前必须先立 ADR（见 docs/research/early-file-identity.md §8）。',
      )
      record(a, b, [])
      return
    }

    const rows = [...names].map((name) => {
      const va = state.captured[a].指纹[name]
      const vb = state.captured[b].指纹[name]
      return {
        字段: name,
        通道A: va ?? '—',
        通道B: vb ?? '—',
        相同: va && vb ? (va === vb ? '✓ 是' : '✗ 否') : '—',
      }
    })

    console.table(rows)

    const extA = state.captured[a].扩展名
    const extB = state.captured[b].扩展名
    say(
      'info',
      `元信息：A=${JSON.stringify(extA)} B=${JSON.stringify(extB)} ` +
        `（扩展名来源：A=${state.captured[a].扩展名来源 ?? '未找到'} / ` +
        `B=${state.captured[b].扩展名来源 ?? '未找到'}）`,
    )

    /**
     * 覆盖 P3 的条件是**两个通道都拿得到扩展名、且两者不同**。原来这行无条件地断称
     * "扩展名不同 = 已覆盖 P3"，而实测两个通道都是 null —— P3 从未被覆盖，却看起来覆盖了。
     */
    if (!extA || !extB) {
      say(
        'warn',
        '至少一个通道没拿到扩展名 ⇒ P3 的「改名」情形未覆盖。' +
          '请把上面"扩展名来源"为「未找到」的通道贴出来 —— 要么取法不对（修好后重扫），' +
          '要么文件名在客户端侧确实不存在。',
      )
    } else if (extA === extB) {
      say(
        'warn',
        `两个通道扩展名相同（${extA}）⇒ P3 未覆盖：` +
          '请把**同一个文件**改个名（如 报告.pdf → 报告(1).pdf）再发一次、重扫、重新 capture。',
      )
    } else {
      say('info', `扩展名不同（${extA} → ${extB}）= 已覆盖 P3 的改名情形。`)
    }

    /** 只有"两侧都拿得到指纹"的行才算真的比过；否则会重演零次比较那类缺陷。 */
    const compared = rows.filter((row) => row.相同 !== '—').length
    if (compared === 0) {
      say(
        'warn',
        `${names.size} 个字段里没有一个两侧都拿得到指纹（值不是字节/字符串，指纹算不出来）` +
          ' —— 仍然**没有比过**。请把报告贴出来一起看这些字段的类型。',
      )
      record(a, b, rows)
      return
    }

    const contentLike = rows.filter((row) => row.相同 === '✓ 是').map((row) => row.字段)
    say(
      'info',
      contentLike.length
        ? `→ 标识「内容」的字段：${contentLike.join(', ')} —— 可用作早期去重键。`
        : `→ 比过的 ${compared} 个字段跨会话都不同：它们只是「对象」标识，不能当去重键（会漏命中）。`,
    )
    record(a, b, rows)
  }

  // ---------------------------------------------------------------------
  // 报告：**一次调用拿到全部结论的纯文本**，就是为了整段贴进聊天窗口。
  // ---------------------------------------------------------------------

  state.report = () => {
    const lines = [
      '# WaaChat 媒体元数据探针报告（P1–P4）',
      '',
      `生成时间：${new Date().toISOString()}`,
    ]

    if (state.runs.length) {
      lines.push(
        '',
        '## 扫描历史',
        ...state.runs.map(
          (run) => `- ${run.at} 集合=${run.label} 消息=${run.messages} 带媒体=${run.mediaCount}`,
        ),
      )
    }

    const last = state.lastScan
    if (last && !last.ok) {
      lines.push('', '## 最近一次扫描没有产出数据', ...last.notes.map((note) => `- ${note}`))
    }

    const good = state.lastGoodScan
    if (!good) {
      lines.push('', '## 还没成功扫描过', '在有媒体的会话里执行 `__waProbe.scan()`，再执行本方法。')
    } else {
      lines.push(
        '',
        '## P1 字段清单（最近一次成功的扫描）',
        `- 消息集合：${good.label}`,
        `- 消息 ${good.messages} 条，其中带媒体 ${good.mediaCount} 条`,
        '',
        markdownTable(
          ['字段', '出现', '类型', '消息类型', '明文哈希', '密钥派生'],
          good.rows.map((row) => [
            row.字段,
            row.出现,
            row.类型,
            row.消息类型,
            row.明文哈希,
            row.密钥派生,
          ]),
        ),
        '',
        '## P1 结论',
        ...good.notes.map((note) => `- ${note}`),
      )
    }

    lines.push('', '## P2/P3 跨会话比较')
    const channels = Object.keys(state.captured)
    if (!channels.length) {
      lines.push('（还没 capture。见文件头的 P2 步骤。）')
    }

    for (const channel of channels) {
      const captured = state.captured[channel]
      const prints = Object.entries(captured.指纹)
        .map(([name, value]) => `${name}=${value ?? '（算不出指纹）'}`)
        .join('；')

      lines.push(
        '',
        `### 通道 ${channel}`,
        `- 消息类型：${captured.消息类型}`,
        `- 扩展名：${JSON.stringify(captured.扩展名)}（来源：${captured.扩展名来源 ?? '未找到'}）`,
        `- 字段数：${captured.字段数}`,
        `- 指纹：${prints || '（空：没有可指纹化的字段）'}`,
      )
      if (captured.警告) lines.push(`- ⚠️ ${captured.警告}`)
    }

    const compare = state.lastCompare
    if (compare) {
      lines.push('', `### compare（A=${compare.a ?? '—'} B=${compare.b ?? '—'}）`)
      if (compare.rows.length) {
        lines.push(
          '',
          markdownTable(
            ['字段', '通道A', '通道B', '相同'],
            compare.rows.map((row) => [row.字段, row.通道A, row.通道B, row.相同]),
          ),
        )
      }
      lines.push('', ...compare.notes.map((note) => `- ${note}`))
    }

    return lines.join('\n')
  }

  /**
   * 把报告放进剪贴板。
   *
   * 剪贴板 API 需要焦点/用户手势，控制台里**可能**被拒 —— 被拒时必须说清楚怎么办，
   * 而不是留下一个"点了没反应"。因此无论成败都把报告**返回**：再复制一次返回值就行。
   */
  state.copy = () => {
    const text = state.report()
    const clipboard = globalThis.navigator?.clipboard

    if (typeof clipboard?.writeText !== 'function') {
      console.warn('[探针] 这个上下文没有 navigator.clipboard：请直接复制 report() 的返回值。')
      return text
    }

    clipboard.writeText(text).then(
      () => console.info(`[探针] 报告已进剪贴板（${text.length} 个字符）。`),
      (error) =>
        console.warn(
          `[探针] 写剪贴板失败（${error?.name ?? 'Error'}）：请直接复制 report() 的返回值。`,
        ),
    )

    return text
  }

  /**
   * 开发模式（`src/main/dev-probe.ts`）注入时先把它设成 'inject'：那样本文件**只装 API、
   * 不立刻扫描**。理由：注入发生在 did-finish-load，那时上游的 store 往往还没起来，立刻扫描
   * 会把"没找到消息集合"这条**假警报**打出来 —— 而它在粘贴流程里是一条真诊断。
   *
   * 标记是**一次性**的：读完就删，因此之后再手动粘贴本文件仍会照常自动扫描。
   */
  const bootstrap = window.__waProbeBootstrap
  delete window.__waProbeBootstrap

  if (bootstrap === 'inject') {
    console.info(
      '[探针] 已由开发模式装载（未自动扫描，避免上游未就绪时的假警报）。' +
        '在有媒体的会话里执行：__waProbe.scan()',
    )
  } else {
    scan()
  }

  console.info(
    '[探针] 可用：__waProbe.scan() / ready() / capture("A") / capture("B") / compare() / report() / copy()',
  )
})()
