/**
 * 早期内容身份（H1，[ADR-0047]）：**在下载发生之前**就认出"这份文件已经在归档里"，
 * 从而直接打开本地那份、作废这次下载。
 *
 * ── 钥匙是 `msg.filehash` ──
 *
 * 真机实测（2026-10-10，证据见 `docs/research/early-file-identity.md` §10）：它就是
 * **文件明文的 SHA-256**（base64 的 32 字节），与归档索引里的 `hash`（hex）是**同一个值**，
 * 只差一次 base64→hex。它不是密钥派生的 HMAC，因此读它不碰 INV-3 的实质；
 * [ADR-0047] 已把 `filehash` 从守卫的禁用标识符里移出。
 *
 * ── 为什么是 `executeJavaScript`，不是 preload ──
 *
 * 承载上游页面的窗口**不挂 preload**（`window.ts` 顶部那条结构性保证）。这里沿用
 * [ADR-0046] 的注入方式：主进程在需要时求值一段**只读**脚本，不新增任何桥。
 *
 * ── 纪律 ──
 *
 * - **只读**：不下载、不发请求、不改页面状态、不读密钥。
 * - **页面送回来的东西一律当作不可信**：只接受"能解码成恰好 32 字节的 base64"的值，
 *   命中之后还要再对一次大小（见 `download.ts` 的 `findArchivedByHash`）。
 * - **拿不准一律返回 `null`**，让调用方回落到今天的行为 —— 这条路线**允许失效，
 *   不允许静默错命中**（`media-capture.md`：宁可漏命中，不可错命中）。
 *
 * ── 同一个通道还回答第二个问题：这条文件属于哪条会话（[ADR-0055]）──
 *
 * 归档路径要按 `<账号>/<会话ID>/files/` 分层，而会话ID 只存在于页面模型里。因此这里除了
 * {@link pageLookupExpression}（按"文件名 + 大小"找内容哈希）之外，还导出
 * {@link pageChatIdExpression}：**按内容哈希**反查那条消息，取它所属会话的 **JID**
 * （`msg.id.remote`，如 `18665597400@c.us`）。
 *
 * 用哈希而不是"文件名 + 大小"作键，是因为归档那一刻哈希已经算出来了（它就是归档的
 * 内容身份），而哈希相等 ⇔ 内容相同 —— 比名字+大小精确得多。代价是：同一份内容出现在
 * **不同会话**里时会得到两个 JID，那时 {@link pickSingle} 判为不唯一、返回 `null`，
 * 调用方回落到 `unknown-chat`（宁可分不出，不可分错）。
 */

/** 一份内容的明文 SHA-256 是 32 字节；base64 之后固定 44 个字符。 */
const SHA256_BYTES = 32

/**
 * 页面侧查询脚本。
 *
 * 只依赖**消息模型本身**（`WAWebCollections.Msg`），不碰 DOM、不碰 CSS 选择器、
 * 不碰 React 内部 —— 上游改版时要改的只有这一个文件。
 *
 * 判据是"文件名（若有）+ 字节数"，两者都来自下载事件（内核给的，不是页面给的）：
 *  - 有文件名：先用文件名缩小范围；**一个都没匹配上就直接放弃**（不退回"按大小猜"）。
 *  - 没文件名（图片/视频在客户端模型里没有文件名，实测 15/15 都没有）：才按字节数筛。
 *
 * 返回值是**去重后的 `filehash` 列表**：多于一个说明无法判定，调用方会放弃。
 */
export function pageLookupExpression(name: string, bytes: number): string {
  const nameLiteral = quoteForPage(name)
  const bytesLiteral = Number.isFinite(bytes) && bytes > 0 ? String(Math.trunc(bytes)) : 'null'

  return `(() => {
  const NAME = ${nameLiteral};
  const BYTES = ${bytesLiteral};
  try {
    const collection = window.require ? window.require('WAWebCollections') : null;
    const Msg = collection ? collection.Msg : null;
    const messages = Msg && typeof Msg.getModelsArray === 'function' ? Msg.getModelsArray() : [];

    const str = (holder, key) => {
      try { const value = holder ? holder[key] : null; return typeof value === 'string' && value ? value : null; }
      catch (error) { return null; }
    };
    const num = (holder, key) => {
      try { const value = holder ? holder[key] : null; return typeof value === 'number' && isFinite(value) ? value : null; }
      catch (error) { return null; }
    };

    const nameOf = (msg) => str(msg, 'filename') || str(msg, 'name') || str(msg.mediaData, 'filename') || str(msg.mediaData, 'name');
    const sizeOf = (msg) => num(msg, 'size') || num(msg, 'filesize') || num(msg, 'fileLength') || num(msg, 'byteLength') || num(msg.mediaData, 'size') || num(msg.mediaData, 'filesize') || num(msg.mediaData, 'fileLength');
    const hashOf = (msg) => str(msg, 'filehash') || str(msg.mediaData, 'filehash') || str(msg.mediaObject, 'filehash');

    const media = messages.filter((msg) => msg && (msg.mediaData || msg.mediaObject));

    let candidates = media;
    if (NAME) {
      const byName = media.filter((msg) => nameOf(msg) === NAME);
      if (!byName.length) return JSON.stringify({ hashes: [] });
      candidates = byName;
    }

    // 字节数只用来**缩小范围**，不是判据：字段名取不到（上游改版）时"筛完为空"只说明我们
    // 不知道它多大，**不等于没匹配上** —— 那就保留按名字得到的候选。真正的安全校验在主进程：
    // 拿**下载本身**的大小去比归档记录，与这里的字段名无关。反过来，没有文件名（图片/视频
    // 在模型里没有）时字节数是唯一线索，筛不空才敢用。
    if (BYTES !== null) {
      const bySize = candidates.filter((msg) => sizeOf(msg) === BYTES);
      if (bySize.length) candidates = bySize;
      else if (!NAME) return JSON.stringify({ hashes: [] });
    } else if (!NAME) {
      return JSON.stringify({ hashes: [] });
    }

    const hashes = [];
    for (const msg of candidates) {
      const hash = hashOf(msg);
      if (hash && hashes.indexOf(hash) === -1) hashes.push(hash);
    }
    return JSON.stringify({ hashes: hashes });
  } catch (error) {
    return JSON.stringify({ hashes: [] });
  }
})()`
}

/**
 * 把一个字符串安全地嵌进要在页面里求值的源码。
 *
 * 文件名是**不可信输入**（由对端发送者决定，`archive/naming.ts` 也这么说过），直接拼进
 * 源码就是注入。`JSON.stringify` 之外还要转义 U+2028 / U+2029：它们在 JSON 字符串里合法，
 * 但在早于 ES2019 的 JS 字符串字面量里是换行 —— 与其依赖运行时版本，不如转掉。
 */
function quoteForPage(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * 页面送回来的是 `JSON.stringify({ hashes })` 文本。解析失败一律当作"没有"。
 */
export function readPageHashes(raw: unknown): string[] {
  if (typeof raw !== 'string') return []

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return []
    const hashes = (parsed as { hashes?: unknown }).hashes
    return Array.isArray(hashes)
      ? hashes.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

/**
 * 把页面给的 `filehash`（base64 的 32 字节）换成归档索引用的 hex 形式。
 *
 * 严格到"宁可不认"：长度不对、字符集不对、或**宽松解码后往返不一致**（`Buffer.from` 会
 * 悄悄忽略畸形输入里的多余字符）都返回 `null`。这个值决定"打开哪一个本地文件"，
 * 认错了就是把用户开到无关的文件上。
 */
export function decodeFilehash(value: unknown): string | null {
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null

  const buffer = Buffer.from(trimmed, 'base64')
  if (buffer.length !== SHA256_BYTES) return null
  // 往返一次：只比较去掉填充的部分，因为填充的写法可能不同。
  if (buffer.toString('base64').replace(/=+$/, '') !== trimmed.replace(/=+$/, '')) return null

  return buffer.toString('hex')
}

/**
 * 从候选里取**唯一**那一个。
 *
 * 空、或有两个及以上不同的值 ⇒ `null`（无法判定）。同一个值出现多次（同一份内容被转发）
 * 仍算唯一。
 */
export function pickSingle(values: readonly (string | null)[]): string | null {
  const unique = [...new Set(values.filter((value): value is string => value !== null))]
  return unique.length === 1 ? unique[0] : null
}

/**
 * 主进程拿到页面回复后的**唯一**入口：解析 → 解码 → 取唯一值。
 *
 * 任何一步不确定都得到 `null`，调用方据此回落。
 */
export function pickContentHash(raw: unknown): string | null {
  return pickSingle(readPageHashes(raw).map(decodeFilehash))
}

// ---------------------------------------------------------------------------
// 会话ID（[ADR-0055]，取代 [ADR-0052] 的消息ID）
// ---------------------------------------------------------------------------

/**
 * 归档用的内容哈希是 hex（`blobs.sha256File()` 的产物），而页面上的 `msg.filehash` 是
 * **同一份明文的 base64**。这里把 hex 换回 base64，好让页面侧直接做字符串比较。
 *
 * 严格：不是 64 位小写 hex 就返回 `null`（调用方据此放弃，而不是拿一个乱值去比）。
 */
export function encodeFilehash(hex: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null

  return Buffer.from(hex, 'hex').toString('base64')
}

/**
 * 页面侧查询脚本：**按内容哈希**找那条消息，回传它所属**会话**的 JID。
 *
 * 与 {@link pageLookupExpression} 同样的纪律：只依赖消息模型本身、只读、拿不准返回空。
 * 匹配条件只有一条 —— `filehash` 与我们算出的内容哈希逐字相同（两者都是明文的 SHA-256）。
 *
 * ⚠️ **取的是 `msg.id.remote`（会话 JID），不是 `msg.id.id`（消息ID）**，也不是
 * `msg.id._serialized`（那个串是 `<fromMe>_<remote>_<消息ID>`，把它当会话用会把每条消息
 * 都变成一个"会话"）。`remote` 在页面上是 Wid 对象，因此字符串与 `._serialized` 两种形态都读；
 * 都取不到时回落 `msg.from`（同一个 JID 的另一种写法）。
 *
 * 返回 `{ ids: [...] }`：多于一个说明同一份内容出现在**不同会话**里，调用方会放弃并回落。
 */
export function pageChatIdExpression(filehash: string): string {
  const hashLiteral = quoteForPage(filehash)

  return `(() => {
  const HASH = ${hashLiteral};
  try {
    const collection = window.require ? window.require('WAWebCollections') : null;
    const Msg = collection ? collection.Msg : null;
    const messages = Msg && typeof Msg.getModelsArray === 'function' ? Msg.getModelsArray() : [];

    const str = (holder, key) => {
      try { const value = holder ? holder[key] : null; return typeof value === 'string' && value ? value : null; }
      catch (error) { return null; }
    };
    const hashOf = (msg) => str(msg, 'filehash') || str(msg.mediaData, 'filehash') || str(msg.mediaObject, 'filehash');
    // 会话 JID：msg.id.remote 优先（它是 MsgKey 的一部分），再回落 msg.from。
    const chatOf = (msg) => {
      if (!msg) return null;
      const remote = msg.id ? msg.id.remote : null;
      if (typeof remote === 'string' && remote) return remote;
      const serialized = str(remote, '_serialized');
      if (serialized) return serialized;
      if (typeof msg.from === 'string' && msg.from) return msg.from;
      return str(msg.from, '_serialized');
    };

    const ids = [];
    for (const msg of messages) {
      if (!msg) continue;
      if (hashOf(msg) !== HASH) continue;
      const id = chatOf(msg);
      if (id && ids.indexOf(id) === -1) ids.push(id);
    }
    return JSON.stringify({ ids: ids });
  } catch (error) {
    return JSON.stringify({ ids: [] });
  }
})()`
}

/**
 * 页面送回来的是 `JSON.stringify({ ids })` 文本。解析失败一律当作"没有"。
 */
export function readPageChatIds(raw: unknown): string[] {
  if (typeof raw !== 'string') return []

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return []
    const ids = (parsed as { ids?: unknown }).ids
    return Array.isArray(ids)
      ? ids.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

/**
 * 主进程拿到页面回复后的**唯一**入口：解析 → 取唯一值。
 *
 * 空、或有两个及以上不同的会话ID ⇒ `null`（无法判定），调用方回落到 `unknown-chat`。
 */
export function pickChatId(raw: unknown): string | null {
  return pickSingle(readPageChatIds(raw))
}
