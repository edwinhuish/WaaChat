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
 * ── 它在回答什么（两张表是全部重点）────────────────────────────────────────
 *
 * 1. **字段清单（按形状）**：媒体载荷可能挂在 `msg.mediaData`（给界面用的媒体模型）、
 *    `msg.mediaObject`、或 `msg` 自身（wire 层的 fileSha256 / mediaKey / directPath 是
 *    **消息字段**）。所以这里**逐个形状都列一遍**，而不是取第一个命中的就收工。
 * 2. **载荷定位（字段 × 容器）**：按"字段 × 容器"数**取到值**的条数。
 *
 * ⚠️ 为什么必须区分「名字在」与「取到值」：实测（2026-10-10）`msg.mediaData` 上
 * `mediaKey` / `directPath` / `fileSha256` 都是"**名字在、值为 undefined**"（原型链上的
 * getter 取不到值），而 `filehash` / `size` / `mimetype` 有值。只看字段名就会把
 * `mediaKey` 报成「✓ 有」，也会把一个**假阴性**（把"没在这一层"当成"客户端没有"）当成结论。
 *
 * ⚠️ 也别被名字骗过去：`thumbnailSha256` / `thumbnailEncSha256` 是**缩略图**的那一对，
 * 与"媒体文件本身的内容身份"无关。上一版按 /sha256/ 一匹配就把它们当成了 `fileSha256`，
 * 于是打出了「走方案 B」。**假阳性比"没找到"危险得多**：它会让人以为路已经通了。
 *
 * ── 实测到的事实（2026-10-10，两次扫描，21 条媒体）─────────────────────────
 *
 * | 字段 | 在哪儿取到了值 |
 * |---|---|
 * | `directPath` / `mediaKey` / `mediaKeyTimestamp` / `deprecatedMms3Url` | `msg`（**消息**自身；`msg.mediaData` 上只有名字、没有值） |
 * | `filehash` / `encFilehash`（各 44 字符 = base64 的 32 字节） | `msg`、`msg.attributes`、`msg.mediaData`、`msg.mediaObject` |
 * | `thumbnailSha256` / `thumbnailEncSha256` | `msg`、`msg.attributes` |
 * | `fileSha256` / `fileEncSha256` | **一处都没有**（连名字都没有） |
 *
 * 由此得到一个**只能靠 P2 判定**的问题：`filehash` 究竟是
 * 「明文的 SHA-256（= 方案 B 要的那个值，与归档里的 `hash` 同构）」还是
 * 「对密文做的 HMAC（mediaKey 经 HKDF 派生 ⇒ 属 INV-3）」。
 * 命名上它与 `encFilehash` 成对，像 `fileSha256`/`fileEncSha256` 的改名；但研究文档
 * （`early-file-identity.md` §3 候选 3）记的是后者。**P2 能直接区分**：
 * 同一个文件在两个会话里**各自重新发送**，内容型必然相同、对象型必然不同。
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
 *   b. 切到会话 B，把**同一个文件重新发送一次**（⚠️ **不是转发**；P3 可以先改个名字再发）
 *      → 为什么要强调"不是转发"：转发会复用**同一个媒体对象**，两个通道于是本来就指向同一份
 *        东西 —— 那时任何字段"相同"都不能证明它是内容身份。`compare()` 会检查这一点
 *        （对象标识控制项：`directPath` / `deprecatedMms3Url`），相同就警告。
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
 * - `filehash` 家族（`filehash` / `encFilehash`）**默认不指纹化**：它可能是对密文做的 HMAC
 *   （macKey 由 mediaKey 经 HKDF 派生），那属 INV-3 范围。实测（2026-10-10）P1 已经表明
 *   "客户端侧没有 fileSha256、只有这一族"，也就是说**岔路口到了**：要读它们的值来判定
 *   内容/对象身份，就必须**先就 INV-3 立一条 ADR**（research §8），再把
 *   `CFG.fingerprintKeyDerived` 改成 true。那是为了确认岔路口存在，不是实现。
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

  /**
   * 可以指纹化的字段。
   *
   * **不含 `mediaKey`** —— 那是密钥本身，任何情况下都不读它的值（INV-3）。
   * `filehash` 家族（`filehash` / `encFilehash`）默认也在外面：它到底是不是密钥派生的，
   * 要靠 P2 判定（见文件头），所以读它的值需要先就 INV-3 表态。
   * 这里列的是**实测里真的取到过值**的名字（2026-10-10）。
   */
  const FINGERPRINTABLE = new Set([
    'fileSha256',
    'fileEncSha256',
    'thumbnailSha256',
    'thumbnailEncSha256',
    'directPath',
    'deprecatedMms3Url',
  ])

  /**
   * 对象标识的**控制项**：它们标识"哪一个媒体对象"，不是"哪一份内容"。
   *
   * 为什么必须有：P2 的推理前提是"两个会话**各自上传**了一次"。若第二次是**转发**（或上游
   * 复用了同一个对象），两个通道本来就指向同一个对象 —— 那时任何字段"相同"都不能证明它是
   * 内容身份。上一版没有这个控制项，于是"指纹相同 ⇒ 内容身份"可能建立在假前提上。
   */
  const OBJECT_MARKERS = new Set(['directPath', 'deprecatedMms3Url'])

  /** 表里的 ★：媒体本身的明文 SHA-256（**不含**缩略图的）。 */
  const isPlainSha = (name) => /^(file)?sha256$/i.test(name)

  /** 表里的 ⚠ INV-3：`filehash` 家族 —— 保守起见在**判定之前**都不碰。 */
  const isFileHashFamily = (name) => /filehash$/i.test(name)

  /**
   * 打开 `CFG.fingerprintKeyDerived` 之后才允许指纹化的**名字**（实测里存在的两个）。
   *
   * ⚠️ 这一步是**要就 INV-3 表态**的：它读的是可能由 mediaKey 派生的值。开关默认关着，
   * 且开之前必须先立 ADR（见文件头与 `docs/research/early-file-identity.md` §8）。
   */
  const KEY_DERIVED = ['filehash', 'encFilehash']

  /**
   * P1 的候选项分成**组**，每个字段归入"第一个匹配的规则"。
   *
   * ⚠️ 为什么必须分组：`thumbnailSha256` 同样匹配 /sha256/i，但它是**缩略图**的明文哈希，与
   * "媒体文件本身的内容身份"是两码事。上一版把它当成了 `fileSha256`，于是对着一份客户端根本
   * 不暴露 fileSha256 的数据打出了「走方案 B —— 下载前就能拿到内容哈希」。这是**假阳性**，
   * 比"没找到"危险得多：它会让人以为路已经通了（实测 2026-10-10 踩到）。
   */
  const CANDIDATE_RULES = [
    {
      key: 'plain',
      label: '媒体本身的明文 SHA-256',
      test: (name) => /^(file)?sha256$/i.test(name),
    },
    {
      key: 'enc',
      label: '媒体本身的密文 SHA-256',
      test: (name) => /^(file)?encsha256$/i.test(name),
    },
    {
      key: 'thumbnail',
      label: '缩略图的 SHA-256（与媒体去重无关）',
      test: (name) => /^thumbnail/i.test(name),
    },
    {
      key: 'filehash',
      label: 'filehash 家族（是不是密钥派生，**待判定**）',
      test: isFileHashFamily,
    },
  ]

  /**
   * 载荷可能在哪：这些名字来自 wire 层（research §3），而客户端模型可能把它们搬进某个容器
   * （`$1` / `attributes` …）或干脆不留。矩阵只数**取到值**的条数。
   */
  const PAYLOAD_FIELDS = [
    'fileSha256',
    'fileEncSha256',
    'mediaKey',
    'mediaKeyTimestamp',
    'directPath',
    'filehash',
    'encFilehash',
    'objectId',
    'url',
  ]

  /** 容器：从消息自身到它下面一层。`$1` / `attributes` 是上游模型的内部承载。 */
  const CONTAINERS = [
    ['msg', (msg) => msg],
    ['msg.$1', (msg) => msg?.$1],
    ['msg.attributes', (msg) => msg?.attributes],
    ['msg.mediaData', (msg) => msg?.mediaData],
    ['msg.mediaData.$1', (msg) => msg?.mediaData?.$1],
    ['msg.mediaData.attributes', (msg) => msg?.mediaData?.attributes],
    ['msg.mediaObject', (msg) => msg?.mediaObject],
  ]

  /** 表格与报告的显示顺序：载荷候选在前，消息自身在后。固定顺序，两次运行才好对照。 */
  const SHAPE_ORDER = ['msg.mediaData', 'msg.mediaObject', 'msg.get("mediaData")', 'msg']

  function shapeOrder(path) {
    const index = SHAPE_ORDER.indexOf(path)
    return index === -1 ? SHAPE_ORDER.length : index
  }

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

  const kindOf = (info) => `${info.kind}${info.detail ? `(${info.detail})` : ''}`

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

  /**
   * 字段信息里"有没有取到值"。
   *
   * `undefined` 与 `null` 都不算值 —— 它们正是"名字在、值没有"的那一类，而这条区别是整个
   * 探针的结论能否成立的关键（见文件头）。
   */
  const hasValue = (info) => [...info.kinds].some((kind) => !/^(undefined|null)/.test(kind))

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

  /** 这条消息是不是"带媒体" —— 只看**有没有**媒体容器，不看里面有没有值。 */
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
   * 媒体载荷可能挂在几个地方，**全都列出来**（不取第一个就收工）。
   *
   * 为什么必须"全都"：实测（2026-10-10）`msg.mediaData` 上的 `mediaKey` / `directPath` /
   * `fileSha256` 全是"名字在、值为 undefined"，而 `filehash` / `size` / `mimetype` 有值 ——
   * 说明它大概率只是**给界面用**的媒体模型，wire 层的载荷在别处。上一版只认第一个命中的对象，
   * 于是"客户端侧没有 fileSha256"这个结论下得没有根据。
   */
  function shapesOf(msg) {
    const found = []

    const push = (path, value) => {
      if (!value) return
      if (found.some((shape) => shape.value === value)) return // 同一个对象只列一次
      found.push({ path, value })
    }

    push('msg.mediaData', msg.mediaData)
    push('msg.mediaObject', msg.mediaObject)

    if (typeof msg.get === 'function') {
      try {
        push('msg.get("mediaData")', msg.get('mediaData'))
      } catch {
        /* 放弃 */
      }
    }

    // 消息自身：`fileSha256` / `mediaKey` / `directPath` 在 wire 层是**消息字段**，
    // 所以"消息上有没有"必须单独问一次（见 research §3）。
    push('msg', msg)

    return found
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
  function filenameSource(msg) {
    const candidates = [
      ['msg.mediaData.filename', () => msg?.mediaData?.filename],
      ['msg.mediaData.name', () => msg?.mediaData?.name],
      ['msg.mediaObject.filename', () => msg?.mediaObject?.filename],
      ['msg.filename', () => msg?.filename],
    ]

    for (const [label, read] of candidates) {
      let value
      try {
        value = read()
      } catch {
        value = undefined
      }
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
    const shapeIndex = new Map() // 形状路径 → Map(字段 → { count, kinds, types })
    const shapeCounts = new Map() // 形状路径 → 有它的媒体条数
    const payloadIndex = new Map() // 容器 → Map(字段 → { count, kinds })
    const byType = new Map() // 消息类型 → 字段名集合
    let mediaCount = 0
    let lastMedia = null

    for (const msg of messages) {
      if (!mediaOf(msg)) continue

      mediaCount += 1

      const type = String(msg?.type ?? 'unknown')
      const typeKeys = byType.get(type) ?? new Set()
      byType.set(type, typeKeys)

      const shapes = shapesOf(msg)
      const sizes = new Map()

      for (const { path, value } of shapes) {
        const shape = shapeOf(value)
        sizes.set(path, shape.size)
        shapeCounts.set(path, (shapeCounts.get(path) ?? 0) + 1)

        const fields = shapeIndex.get(path) ?? new Map()
        shapeIndex.set(path, fields)

        for (const [name, info] of shape) {
          typeKeys.add(name)
          const entry = fields.get(name) ?? { count: 0, kinds: new Set(), types: new Set() }
          entry.count += 1
          entry.kinds.add(kindOf(info))
          entry.types.add(type)
          fields.set(name, entry)
        }
      }

      for (const [container, get] of CONTAINERS) {
        let holder
        try {
          holder = get(msg)
        } catch {
          holder = undefined
        }
        if (!holder) continue

        const fields = payloadIndex.get(container) ?? new Map()
        payloadIndex.set(container, fields)

        for (const field of PAYLOAD_FIELDS) {
          let value
          try {
            value = holder[field]
          } catch {
            value = undefined
          }
          if (value === undefined) continue

          const entry = fields.get(field) ?? { count: 0, kinds: new Set() }
          entry.count += 1
          entry.kinds.add(kindOf(describe(value)))
          fields.set(field, entry)
        }
      }

      lastMedia = { msg, shapes, sizes }
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
          '        再重扫。⚠️ "字段到了才出现" 本身就是要记录的数据点：它决定能不能"下载前"拿到标识。',
      )
      state.lastScan = {
        ok: false,
        at,
        label,
        messages: messages.length,
        mediaCount: 0,
        shapes: [],
        byType: [],
        payload: null,
        notes,
      }
      return { ok: false, label, messages: messages.length, mediaCount: 0 }
    }

    const shapePaths = [...shapeIndex.keys()].sort((a, b) => shapeOrder(a) - shapeOrder(b))
    say(
      'info',
      `媒体对象出现的形状：${shapePaths.map((path) => `${path}（${shapeCounts.get(path)}/${mediaCount}）`).join('、')}`,
    )

    // ---- 字段清单：一张表一个形状 ----
    const shapeTables = shapePaths.map((path) => ({
      path,
      count: shapeCounts.get(path),
      rows: [...shapeIndex.get(path).entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([name, info]) => ({
          字段: name,
          出现: `${info.count}/${mediaCount}`,
          类型: [...info.kinds].slice(0, 2).join(' | '),
          消息类型: [...info.types].join(','),
          明文哈希: isPlainSha(name) ? '★' : '',
          密钥派生: isFileHashFamily(name) ? '⚠ INV-3' : '',
        })),
    }))

    for (const table of shapeTables) {
      console.info(
        `[探针] 字段清单 · ${table.path}（${table.count}/${mediaCount} 条媒体上有这个形状）`,
      )
      console.table(table.rows)
    }

    const byTypeCounts = [...byType.entries()].map(([type, keys]) => [type, keys.size])
    console.info('[探针] P4 逐类型字段数（所有形状相加）：', Object.fromEntries(byTypeCounts))
    notes.push(
      `P4 逐类型字段数（所有形状相加）：${byTypeCounts
        .map(([type, size]) => `${type}=${size}`)
        .join(' ')}`,
    )

    // ---- 载荷定位：字段 × 容器，只数**取到值**的条数 ----
    const containers = CONTAINERS.map(([name]) => name).filter((name) => payloadIndex.has(name))

    const payloadRows = PAYLOAD_FIELDS.map((field) => {
      const row = { 字段: field }

      for (const container of containers) {
        const entry = payloadIndex.get(container)?.get(field)
        row[container] = entry
          ? `${entry.count}/${mediaCount} ${[...entry.kinds].join(' | ')}`
          : '—'
      }

      return row
    })

    console.info('[探针] 载荷定位（只数**取到值**的条数；`—` = 那一层没取到值）')
    console.table(payloadRows)
    notes.push('载荷定位：按「字段 × 容器」数**取到值**的条数，`—` = 那一层没取到值')

    // ---- 结论行：这是这个探针存在的唯一目的 ----
    const byRule = new Map(CANDIDATE_RULES.map((rule) => [rule.key, []]))
    const mediaKeyHits = []

    for (const [shape, fields] of shapeIndex) {
      for (const [name, info] of fields) {
        const hit = { shape, name, valued: hasValue(info) }
        if (/^mediakey$/i.test(name)) mediaKeyHits.push(hit)

        /** 归入**第一个**匹配的规则 —— 顺序即优先级（`thumbnail*` 因此不会被当成媒体本身的）。 */
        const rule = CANDIDATE_RULES.find((candidate) => candidate.test(name))
        if (rule) byRule.get(rule.key).push(hit)
      }
    }

    const siteOf = (hit) => `${hit.shape}.${hit.name}`
    const verdict = (hits) => {
      const valued = hits.filter((hit) => hit.valued)
      if (valued.length) return `✓ 有（${valued.map(siteOf).join('、')}）`
      if (hits.length) {
        return `✗ 没有值（名字在、但取不到值：${hits.map(siteOf).join('、')}）`
      }
      return '✗ 连字段名都没有'
    }

    const hasPlain = byRule.get('plain').some((hit) => hit.valued)
    const hasFileHashFamily = byRule.get('filehash').some((hit) => hit.valued)

    console.group('[探针] P1 结论（以**取到值**为准）')
    for (const rule of CANDIDATE_RULES) {
      say('info', `${rule.label}：${verdict(byRule.get(rule.key))}`)
    }
    say('info', `mediaKey（只报了长度，没取值）：${verdict(mediaKeyHits)}`)
    say(
      'info',
      hasPlain
        ? '→ 走方案 B：下载前就能拿到内容哈希，**不需要**动 INV-3。下一步做 P2（跨会话比较）。'
        : hasFileHashFamily
          ? '→ ⚠️ 媒体本身没有 fileSha256/fileEncSha256；取到值的是 `filehash` 家族（各 44 字符 = base64 的' +
            ' 32 字节）。它**到底是"明文的 SHA-256"还是"对密文做的 HMAC（密钥派生）"，只能靠 P2 判定**——' +
            '要读它的值必须先就 INV-3 表态（见文件头与 research §8）。'
          : '→ ⚠️ 媒体本身两个 SHA-256 都没取到值：先看上面的「载荷定位」表 —— 它按「字段 × 容器」数**取到值**的' +
            '条数，能指出载荷在哪一层。**全为 0** 才说明客户端确实没留（那时才轮到画 INV-3 的线）。',
    )
    console.groupEnd()

    state.lastScan = {
      ok: true,
      at,
      label,
      messages: messages.length,
      mediaCount,
      shapes: shapeTables,
      byType: byTypeCounts,
      payload: { containers, rows: payloadRows },
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
   * ⚠️ 判据是"集合存在**且已经有消息**"，不是"集合存在"：实测（2026-10-10）页面刚加载完时
   * 集合已经能拿到、但里面 **0 条**消息 —— 那一刻扫描只会打印一条没有信息量的
   * "当前会话里没有带媒体的消息"。等它同步出消息，自动扫描才真的扫到了东西。
   */
  state.ready = () => {
    const { collection } = resolveMsgCollection()
    if (!collection) return false
    return listMessages(collection).length > 0
  }

  // ---------------------------------------------------------------------
  // P2 / P3：跨会话比较
  // ---------------------------------------------------------------------

  state.capture = (channel) => {
    const target = state.lastMedia
    if (!target) {
      console.warn('[探针] 还没扫到带媒体的消息，先在有媒体的会话里 scan() 一次。')
      return
    }

    const { msg, shapes, sizes } = target
    const wanted = [...FINGERPRINTABLE, ...(CFG.fingerprintKeyDerived ? KEY_DERIVED : [])]
    const picked = {}
    const origins = {}

    /**
     * 在**所有形状**里找可指纹化的字段，而不是只看第一个：载荷可能挂在 `msg` 自身。
     * 字段名保留为键（同一个值在两层都有时取先出现的那个），另记**来源**供报告显示
     * —— 否则"这个指纹是从哪一层取的"就无从查起。
     */
    for (const { path, value } of shapes) {
      for (const name of wanted) {
        if (name in picked) continue

        let field
        try {
          field = value[name]
        } catch {
          field = undefined
        }
        if (field === undefined || field === null) continue

        picked[name] = fingerprint(field)
        origins[name] = `${path}.${name}`
      }
    }

    const { label: nameFrom, value: filename } = filenameSource(msg)
    const fieldCount = [...sizes.values()].reduce((total, size) => total + size, 0)

    const captured = {
      消息类型: String(msg?.type ?? 'unknown'),
      扩展名: extensionOf(filename),
      扩展名来源: nameFrom,
      字段数: fieldCount,
      指纹: picked,
      指纹来源: origins,
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
    const extA = state.captured[a].扩展名
    const extB = state.captured[b].扩展名

    say(
      'info',
      `元信息：A=${JSON.stringify(extA)} B=${JSON.stringify(extB)} ` +
        `（扩展名来源：A=${state.captured[a].扩展名来源 ?? '未找到'} / ` +
        `B=${state.captured[b].扩展名来源 ?? '未找到'}）`,
    )

    /**
     * P3 的判定**只与扩展名有关**，与"比没比过字段"无关 —— 所以它必须排在任何早退之前。
     * 上一个版本把它排在"没比过就 return"之后，于是通道 A/B 都是 `.xlsx` 时报告里
     * **根本没有 P3 的结论**（实测踩到）：看报告的人会以为 P3 已经覆盖。
     *
     * 覆盖 P3 的条件是**两个通道都拿得到扩展名、且两者不同**。
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
          '        原因通常是两个通道的指纹集合都为空：没有哪个形状上取到了明文/密文 SHA-256。\n' +
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

    /**
     * 对象标识的**控制项**先判：P2 的推理前提是"两个会话各自上传了一次"。若第二次是**转发**
     * （或上游复用了同一个对象），两个通道本来就指向同一个对象 —— 那时任何字段"相同"都不能
     * 证明它是内容身份。少了这一步，"指纹相同 ⇒ 内容身份"会建立在一个**没被检查过**的前提上。
     */
    const sameObject = rows.filter((row) => OBJECT_MARKERS.has(row.字段) && row.相同 === '✓ 是')
    if (sameObject.length) {
      say(
        'warn',
        `⚠️ 对象标识控制项跨会话相同（${sameObject.map((row) => row.字段).join('、')}）⇒ 两个通道很可能是**同一个媒体对象**` +
          '（转发、或上游复用了它）。这时任何字段"相同"都**不能**证明它是内容身份 —— ' +
          '请让第二次是**把同一个文件重新发送一次**（不是转发），再重扫、重新 capture。',
      )
    }

    /**
     * 「内容身份」只能由**非控制项**裁定：对象标识（`directPath` / `deprecatedMms3Url`）按定义
     * 只回答"哪一个对象"，上面已单独判过。若把它们算进来，转发场景下会打出
     * "标识「内容」的字段：directPath" —— 与上一条警告正好相反（实测踩到）。
     */
    const contentRows = rows.filter((row) => !OBJECT_MARKERS.has(row.字段))

    /** 只有"两侧都拿得到指纹"的行才算真的比过；否则会重演零次比较那类缺陷。 */
    const compared = contentRows.filter((row) => row.相同 !== '—').length
    if (compared === 0) {
      say(
        'warn',
        `${contentRows.length} 个可当内容身份的字段里没有一个两侧都拿得到指纹（值不是字节/字符串，指纹算不出来）` +
          ' —— 仍然**没有比过**。请把报告贴出来一起看这些字段的类型。',
      )
      record(a, b, rows)
      return
    }

    const contentLike = contentRows.filter((row) => row.相同 === '✓ 是').map((row) => row.字段)
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
        '## 字段清单（按形状）',
        `- 消息集合：${good.label}`,
        `- 消息 ${good.messages} 条，其中带媒体 ${good.mediaCount} 条`,
        `- 媒体对象出现的形状：${good.shapes
          .map((shape) => `${shape.path}（${shape.count}/${good.mediaCount}）`)
          .join('、')}`,
      )

      for (const shape of good.shapes) {
        lines.push(
          '',
          `### 形状 ${shape.path}（${shape.count}/${good.mediaCount}）`,
          '',
          markdownTable(
            ['字段', '出现', '类型', '消息类型', '明文哈希', '密钥派生'],
            shape.rows.map((row) => [
              row.字段,
              row.出现,
              row.类型,
              row.消息类型,
              row.明文哈希,
              row.密钥派生,
            ]),
          ),
        )
      }

      if (good.payload) {
        lines.push(
          '',
          '## 载荷定位（字段 × 容器；只数**取到值**的条数，`—` = 那一层没取到值）',
          '',
          markdownTable(
            ['字段', ...good.payload.containers],
            good.payload.rows.map((row) => [
              row.字段,
              ...good.payload.containers.map((container) => row[container]),
            ]),
          ),
        )
      }

      lines.push('', '## P1 结论', ...good.notes.map((note) => `- ${note}`))
    }

    lines.push('', '## P2/P3 跨会话比较')
    const channels = Object.keys(state.captured)
    if (!channels.length) {
      lines.push('（还没 capture。见文件头的 P2 步骤。）')
    }

    for (const channel of channels) {
      const captured = state.captured[channel]
      const prints = Object.entries(captured.指纹)
        .map(
          ([name, value]) =>
            `${name}=${value ?? '（算不出指纹）'}` +
            (captured.指纹来源?.[name] ? `（来自 ${captured.指纹来源[name]}）` : ''),
        )
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
