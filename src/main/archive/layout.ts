/**
 * 归档目录的**账号 × 会话分区**（[ADR-0055]，取代 [ADR-0052] 的第二级；分区维度本身由
 * [ADR-0052] 从 [ADR-0037] / [ADR-0039] 的「账号 × 年-月」换来）。
 *
 * 归档正文落在 `<归档目录>/<账号>/<会话ID>/files/<文件名>`：
 *
 *   ~/Documents/WaaChat_files/18665597400/18665597400@c.us/files/2026年第三季度采购合同.pdf
 *
 * 为什么值得一个独立模块（与 `naming.ts` 同样的理由）：这里是**纯函数**
 * —— 不碰文件系统、不导入 electron、不认识 SQLite —— 因此"会话ID 算不算一个合法容器段"
 * "账号名算不算我们的容器""什么样的相对路径算安全"能被单测直接覆盖，而这几件事都错得很安静：
 *
 *   - **会话ID 不净化**：它来自页面（不可信输入），拼进路径就是一个穿越点或一个怪目录名。
 *   - **相对路径不净化**：`stored_name` 来自索引（我们自己的数据），但它一旦被手工
 *     改坏、或将来换了写入方，`join(归档目录, stored_name)` 就是一个路径穿越点。
 *   - **容器判据放宽**：迁移会把用户自己放在归档目录里的目录当成我们的东西搬走
 *     （{@link isAccountSegment} 因此只认 UUID 形状、`unknown-account` 与当前账号）。
 *
 * ⚠️ **旧布局必须继续可读**：第二级在 [ADR-0052] 时期是**消息ID**，因此磁盘上同时存在
 * `<账号>/<消息ID>/files/` 与现在的 `<账号>/<会话ID>/files/` —— 两者形状重叠（见
 * {@link isChatSegment}），都算我们的容器；`<账号>/files/<年-月>/`（[ADR-0039]）、
 * `<年-月>/` 与 `<年>/<月>/`（[ADR-0037]）同理。读取一律逐字用 `stored_name`（位置是事实，
 * 不反推），因此下面的 `isArchiveMonthDir()` / `isLegacy*()` 判据仍然保留，只为迁移与回滚。
 */

/**
 * 拿不到账号标识时用的目录名（[ADR-0039]）。
 *
 * 它是个**正常**状态而不是错误：还没登录、或 cookie 被清过时，文件先落在这里；
 * 之后拿到标识也不会去搬动它们（位置是 `stored_name` 记着的事实，[ADR-0037]）。
 */
export const ACCOUNT_FALLBACK = 'unknown-account'

/**
 * 拿不到会话ID 时用的目录名（[ADR-0055]；[ADR-0052] 时期叫 `unknown-message`）。
 *
 * 与 {@link ACCOUNT_FALLBACK} 对称：会话ID 来自页面（`msg.id.remote`），页面还没加载出来、
 * 注入超时、上游改了字段名、同一份内容出现在**不同会话**里，或这条下载根本不来自聊天
 * （例如页面里的普通下载）时，我们**不猜**，统一落进这一层 —— 文件照常归档，只是分不出是哪条会话。
 *
 * 旧数据里的 `unknown-message/` 不受影响：位置是索引里的事实，照旧可读、可迁移。
 */
export const CHAT_FALLBACK = 'unknown-chat'

/** `wa_ul` 这类标识的形状：UUID。迁移用它把"我们的账号目录"与"用户自己的目录"分开。 */
const ACCOUNT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * 这一段是不是我们建的账号目录。
 *
 * 三种情况认：UUID 形状（今天的标识就是它）、{@link ACCOUNT_FALLBACK}、以及**当前生效的**
 * 那个账号名（万一将来换了标识来源，形状变了也要能迁移自己写下的东西）。
 * 其余目录一律不算 —— 那说明归档目录被别的东西用了，迁移必须**失败**而不是把它们搬走。
 */
export function isAccountSegment(segment: string, current: string): boolean {
  return segment === ACCOUNT_FALLBACK || segment === current || ACCOUNT_UUID_RE.test(segment)
}

/** 明文正文那一层的名字：`<账号>/<会话ID>/files/…`（[ADR-0052] / [ADR-0055]）。 */
export const FILES_SEGMENT = 'files'

/**
 * 会话目录名的最大长度。真的 JID 是几十个字符；留一倍余量给将来的标识形状。
 */
const CHAT_MAX_LENGTH = 128

/**
 * 一个会话目录段的**最小**长度。
 *
 * 用来把"我们写的会话目录"与"用户自己塞进账号目录里的东西"分开（迁移的安全边界，与
 * {@link isAccountSegment} 同一目的）：真的 JID 与消息ID 都远长于 8 个字符，而用户随手建的
 * `stuff/` 之类通常不会既满足 8 字符、又长着 `files/` 子目录。放宽会让迁移错搬用户目录，
 * 收紧会让自己的归档迁移不了 —— 这里取一个偏保守的值。
 */
const CHAT_MIN_LENGTH = 8

/**
 * 会话目录名的合法字符。
 *
 * `@` 是**必须**保留的：会话标识就是 JID（`18665597400@c.us`、`120363012345@g.us`、
 * `123456789012345@lid`），把它换成 `_` 之类我们就再也认不出这个目录属于谁了 —— 而
 * "严格按照 `<账号>/<会话ID>/files/`"这条要求里，可读、可对账的那一半正是这个标识本身。
 * `@` 在 Linux 的文件名里是合法字符（不参与 shell 展开，因为它在词首才有特殊含义）。
 *
 * 大小写敏感：JID 的用户部分与服务器名区分大小写。
 */
const CHAT_UNSAFE = /[^A-Za-z0-9._@-]/g

/**
 * 把页面给的会话ID 整成一个**单段目录名**；不可用时返回 `null`（调用方回落到
 * {@link CHAT_FALLBACK}）。
 *
 * 这是**安全关键**的净化，理由与 `paths.normalizeAccountKey()` 相同：这个值来自页面，
 * 我们把它当目录名用，因此 `/`、`..`、控制字符都必须挡掉。规则：
 *
 *   - 只保留 `[A-Za-z0-9._@-]`（**不**折大小写：JID 区分大小写）；
 *   - 空、`.`、`..`、以点开头都不接受（点开头会与归档内部的 `.part-*` / `.index.sqlite*` 混在一起）；
 *   - 超长截断。
 *
 * 纯函数，因此单测与离线自检都能直接断言它。
 */
export function normalizeChatId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null

  const cleaned = raw.trim().replace(CHAT_UNSAFE, '')
  if (cleaned === '' || cleaned === '.' || cleaned === '..' || cleaned.startsWith('.')) return null

  return cleaned.slice(0, CHAT_MAX_LENGTH)
}

/**
 * 这一段是不是我们建的会话目录（迁移用）。
 *
 * 判据刻意收得紧：先要它是一个合法的单段名（{@link normalizeChatId} 原样通过，
 * 意味着里面没有可剥掉的字符），再有 {@link CHAT_MIN_LENGTH} 以上的长度。
 * {@link CHAT_FALLBACK} 本身满足这两条。
 *
 * ⚠️ 它同时认下 [ADR-0052] 时期的**消息ID** 目录（`3EB0A1B2…`）：那种形状是不含 `@` 的
 * 子集，因此同一条判据覆盖两代数据 —— **不能收紧**，否则老归档的迁移会整次失败
 * （见 ADR-0052 的"已知限制"：形状对不上时迁移失败，而不是把用户目录当成正文搬走）。
 */
export function isChatSegment(segment: string): boolean {
  return normalizeChatId(segment) === segment && segment.length >= CHAT_MIN_LENGTH
}

/**
 * 归档时间（Unix 毫秒）落在哪个月份目录（`2026-10`）。
 *
 * ⚠️ **归档正文已不再用它**（[ADR-0052] 把分区换成了消息/会话）。保留它是因为**密文缓存**
 * （`capture/cache-files.ts`）仍按 `<账号>/<年-月>/` 分层（[ADR-0039]），且那份缓存与承载
 * 方式无关、不在本次改动范围内。
 *
 * 用**本地时间**：这个目录名是给用户看的（在文件管理器里翻），"10 月的东西在 `2026-10` 里"
 * 必须与他手表上的日期一致 —— 用 UTC 会让月底 8 小时的文件落进下一个月。
 *
 * 非有限值（`NaN` / `Infinity`）直接抛：它是调用方的编程错误，而"返回一个荒唐的
 * `NaN-NaN` 目录名"会让错误变成一个悄悄建出来的怪目录。
 */
export function folderFor(openedAt: number): string {
  if (!Number.isFinite(openedAt)) throw new TypeError('archive: openedAt must be a finite number')

  const date = new Date(openedAt)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')

  return `${year}-${month}`
}

/**
 * 这一段是不是月份目录（`2026-10`），[ADR-0037] / [ADR-0039] 旧布局的容器。
 *
 * 写入侧已不再产生它（[ADR-0052]），保留只为**读旧数据与迁移**：
 * `2026-13` / `2026-1` / `2026/10` 都不算。
 */
export function isArchiveMonthDir(segment: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(segment)
}

/**
 * [ADR-0037] 那一版的两层容器（`2026/10/`）。
 *
 * 已经落盘的 `2026/10/` 必须在迁移与读取里继续认；新的写入一律用
 * `<账号>/<消息ID>/files/`（[ADR-0052]）。
 * 判据与 {@link isArchiveMonthDir} 拆开是刻意的：把两者混在一个函数里，将来"哪一版是自己
 * 写的"就分不清了。
 */
export function isLegacyYearDir(segment: string): boolean {
  return /^\d{4}$/.test(segment)
}

/** 旧的月份段（`01`–`12`，只在 `年/月/` 里合法）。 */
export function isLegacyMonthDir(segment: string): boolean {
  return /^(0[1-9]|1[0-2])$/.test(segment)
}

/**
 * 一份正文在归档目录里的**相对路径**（写进索引的 `stored_name` 与 `ArchiveRecord.storedName`）。
 *
 *   账号 / 会话ID / files / 文件名
 *
 * 旧布局（[ADR-0052] 的 `<账号>/<消息ID>/files/…`、`<账号>/files/<年-月>/…`、`2026/10/…`、
 * 裸文件名）**不经过这里** —— 它们的相对路径在写入那一刻就定下了，读取时逐字用
 * （[ADR-0037] 的纪律：位置是事实，不反推）。
 *
 * ⚠️ 三个入参都必须**已经净化**：`account` 来自 `paths.accountKey()`、
 * `chatId` 来自 `normalizeChatId()`（或 {@link CHAT_FALLBACK}）、
 * `fileName` 来自 `naming.sanitizeFileName()`。这里只做拼接，不做校验。
 */
export function archiveStoredPath(account: string, chatId: string, fileName: string): string {
  return `${account}/${chatId}/${FILES_SEGMENT}/${fileName}`
}

/**
 * 把索引里那份 `stored_name` 净化成一个**必定落在归档目录内**的相对路径。
 *
 * 允许的形态（逐版都要认）：
 *
 *   - 裸文件名                        —— [ADR-0031] 到 [ADR-0037] 之间的布局（平面）
 *   - `年/月/文件名`                  —— [ADR-0037] 当时的两层
 *   - `<账号>/files/<年-月>/文件名`   —— [ADR-0039]
 *   - `<账号>/<消息ID>/files/文件名`  —— [ADR-0052] 当时
 *   - `<账号>/<会话ID>/files/文件名`  —— 现在（[ADR-0055]）
 *   - 将来更深的分区                  —— 也认，只要没有 `..`
 *
 * 丢掉空段、`.` 与 `..`，于是 `../../etc/passwd` 变成 `etc/passwd`（归档目录内的一个
 * 名字，找不到就是找不到）。**刻意不抛错**：这个函数在"打开文件"的读路径上，而索引被
 * 手工改坏时，用户该看到的是"文件不存在"，不是一个穿越 IPC 的异常。防的是路径穿越，
 * 不是数据损坏 —— 所以方向选"净化"而不是"拒绝"。
 *
 * 反斜杠不处理：文件名在落盘前已经由 `naming.ts` 把 `\` 换成 `_`，Linux 上它本来也是
 * 合法字符，动它只会让"用户看到的名字"与磁盘上的名字不一致。
 */
export function normalizeStoredPath(storedName: string): string {
  return storedName
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/')
}
