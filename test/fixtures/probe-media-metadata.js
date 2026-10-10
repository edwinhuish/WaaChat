/**
 * 只读探针：WA Web **客户端侧**的媒体元数据里到底有什么。
 *
 * 对应 docs/research/early-file-identity.md 的 P1–P4。
 *
 * 它不是应用代码，而是**粘贴进页面控制台**运行的一段脚本，所以必须自包含
 * （有任何一个 `import` 就没法粘贴）。它由 `test/unit/probe-media-metadata.test.ts`
 * 读取源码后求值来验证 —— 那个测试守着两条不能靠人记住的性质：**绝不打印密钥值**、
 * **必须走原型链上的 getter**。
 *
 * 位置说明：放在 `test/fixtures/` 而不是 `src/` —— 它的宿主是**浏览器**不是 Node，
 * 因此 `eslint.config.mjs` 给它的是 browser globals（见 `PAGE_CONTEXT_FIXTURE`）。
 * 取出来粘贴：`cat test/fixtures/probe-media-metadata.js`
 *
 * ── 怎么跑 ────────────────────────────────────────────────────────────────
 * 1. 启动应用（pnpm run dev），焦点放到「聊天」窗口
 * 2. Ctrl+Shift+I 打开 DevTools → Console
 *      （src/ 里没有任何 setApplicationMenu，所以 Electron 默认菜单还在，
 *        Ctrl+Shift+I 直接可用；控制台默认就是在页面主世界里执行）
 * 3. 把整个文件粘贴进控制台，回车
 *
 * ── P2 / P3 怎么用（跨会话比较）────────────────────────────────────────────
 * WA Web 是单页应用，切聊天不刷新页面，所以 window.__waProbe 会跨会话存活：
 *   a. 在会话 A 里发送/查看那个文件，然后：__waProbe.capture('A')
 *   b. 切到会话 B，把**同一个文件**再发一次（P3 可以先改个名字再发），然后：__waProbe.capture('B')
 *   c. 比较：__waProbe.compare()
 *      → 指纹相同 = 这个字段标识的是「内容」；不同 = 只是「对象」
 *
 * ── 纪律（务必保持）──────────────────────────────────────────────────────
 * - 只读：不下载、不建 Blob、不发请求、不修改任何东西。
 * - 不读密钥：mediaKey 之类只报「长度」，绝不取值、绝不打印。
 * - filehash 是对**密文**做的 HMAC（macKey 由 mediaKey 经 HKDF 派生），属 INV-3 范围。
 *   默认**不**计算它的指纹。只有 P1 表明"客户端侧没有 fileSha256、只有 filehash"时，
 *   才把 CFG.fingerprintKeyDerived 改成 true 再跑一次 —— 那是为了确认岔路口存在，不是实现。
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

  // ---------------------------------------------------------------------
  // 主流程：扫描当前已加载的会话
  // ---------------------------------------------------------------------

  const state = (window.__waProbe ??= { runs: [], captured: {} })
  const { collection, label, tried } = resolveMsgCollection()

  if (!collection) {
    console.warn('[探针] 没找到消息集合。试过的路径：')
    tried.forEach((line) => console.warn('   ', line))
    console.warn('[探针] 这本身就是一个结论：上游把这个内部结构换了位置。请把它记下来。')
    return
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
  state.runs.push({ at: new Date().toISOString(), label, mediaCount, messages: messages.length })

  console.info(`[探针] 消息集合来自：${label}`)
  console.info(
    `[探针] 扫了 ${messages.length} 条消息，其中 ${mediaCount} 条带媒体` +
      (mediaCount ? `；类型：${[...byType.keys()].join(', ')}` : ''),
  )

  if (!mediaCount) {
    console.warn(
      '[探针] 当前会话里没有带媒体的消息。请先打开一个含有图片/视频/文档/语音的会话再跑一次。',
    )
    return
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
  console.info(
    '[探针] P4 逐类型字段数：',
    Object.fromEntries([...byType.entries()].map(([type, keys]) => [type, keys.size])),
  )

  // ---- 结论行：这是这个探针存在的唯一目的 ----
  const keys = [...keyIndex.keys()]
  const hasPlainSha = keys.some((name) => /sha256/i.test(name) && !/enc/i.test(name))
  const hasEncSha = keys.some((name) => /encsha256/i.test(name))
  const hasFileHash = keys.some((name) => /^filehash$/i.test(name))
  const hasMediaKey = keys.some((name) => /mediakey/i.test(name))

  console.group('[探针] P1 结论')
  console.info(`明文 SHA-256 字段（fileSha256 或等价物）：${hasPlainSha ? '✓ 有' : '✗ 没有'}`)
  console.info(`密文 SHA-256 字段（fileEncSha256）：      ${hasEncSha ? '✓ 有' : '✗ 没有'}`)
  console.info(`密钥派生的 filehash：                    ${hasFileHash ? '✓ 有' : '✗ 没有'}`)
  console.info(`mediaKey（只报了长度，没取值）：          ${hasMediaKey ? '✓ 有' : '✗ 没有'}`)
  console.info(
    hasPlainSha
      ? '→ 走方案 B：下载前就能拿到内容哈希，**不需要**动 INV-3。下一步做 P2（跨会话比较）。'
      : hasFileHash
        ? '→ ⚠️ 客户端侧只有 filehash（密钥派生）。要么退回方案 A，要么必须先就 INV-3 立一条 ADR。'
        : '→ ⚠️ 两个都没有：说明客户端把哈希藏在别的结构里，或字段名不同。把上面表格贴出来一起看。',
  )
  console.groupEnd()

  // ---------------------------------------------------------------------
  // P2 / P3：跨会话比较
  // ---------------------------------------------------------------------

  state.capture = (channel) => {
    const target = state.lastMedia
    if (!target) {
      console.warn('[探针] 还没扫到带媒体的消息，先在有媒体的会话里跑一次本探针。')
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

    state.captured[channel] = {
      消息类型: String(msg?.type ?? 'unknown'),
      扩展名: extensionOf(msg?.filename),
      字段数: shape.size,
      指纹: picked,
    }

    console.info(`[探针] 已记录通道 "${channel}"：`, state.captured[channel])
    return state.captured[channel]
  }

  state.compare = () => {
    const channels = Object.keys(state.captured)
    if (channels.length < 2) {
      console.warn('[探针] 至少 capture 两个通道再比较（见文件头的 P2 步骤）。')
      return
    }

    const [a, b] = channels
    const names = new Set([
      ...Object.keys(state.captured[a].指纹),
      ...Object.keys(state.captured[b].指纹),
    ])

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
    console.info(
      `[探针] 元信息：A=${JSON.stringify(state.captured[a].扩展名)} ` +
        `B=${JSON.stringify(state.captured[b].扩展名)} ` +
        `（扩展名不同 = 已覆盖 P3 的改名情形）`,
    )

    const contentLike = rows.filter((row) => row.相同 === '✓ 是').map((row) => row.字段)
    console.info(
      contentLike.length
        ? `→ 标识「内容」的字段：${contentLike.join(', ')} —— 可用作早期去重键。`
        : '→ 没有任何字段跨会话相同：它们都只是「对象」标识，不能当去重键（会漏命中）。',
    )
  }

  console.info('[探针] 可用：__waProbe.capture("A") / __waProbe.capture("B") / __waProbe.compare()')
})()
