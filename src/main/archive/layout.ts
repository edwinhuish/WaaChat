/**
 * 归档目录的**账号 × 时间分区**（[ADR-0037] / [ADR-0039]）。
 *
 * 归档正文落在 `<归档目录>/<账号>/files/<年-月>/<文件名>`：
 *
 *   ~/Documents/WaaChat_files/a1b2c3d4-…/files/2026-10/2026年第三季度采购合同.pdf
 *
 * 为什么值得一个独立模块（与 `naming.ts` 同样的理由）：这里是**纯函数**
 * —— 不碰文件系统、不导入 electron、不认识 SQLite —— 因此"年月怎么算""账号名算不算我们的
 * 容器""什么样的相对路径算安全"能被单测直接覆盖，而这几件事都错得很安静：
 *
 *   - **年月算错**（用 UTC 而不是本地时间、月份从 0 开始忘了 +1）：文件落进相邻的
 *     月份目录，用户不会发现，但"按时间翻文件夹"从此不可信。
 *   - **相对路径不净化**：`stored_name` 来自索引（我们自己的数据），但它一旦被手工
 *     改坏、或将来换了写入方，`join(归档目录, stored_name)` 就是一个路径穿越点。
 *   - **容器判据放宽**：迁移会把用户自己放在归档目录里的目录当成我们的东西搬走
 *     （{@link isAccountSegment} 因此只认 UUID 形状、`unknown-account` 与当前账号）。
 */

/**
 * 拿不到账号标识时用的目录名（[ADR-0039]）。
 *
 * 它是个**正常**状态而不是错误：还没登录、或 cookie 被清过时，文件先落在这里；
 * 之后拿到标识也不会去搬动它们（位置是 `stored_name` 记着的事实，[ADR-0037]）。
 */
export const ACCOUNT_FALLBACK = 'unknown-account'

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

/** 明文正文那一层的名字：`<账号>/files/…`（[ADR-0039]）。 */
export const FILES_SEGMENT = 'files'

/**
 * 归档时间（Unix 毫秒）落在哪个月份目录（`2026-10`，[ADR-0039] 的单层格式）。
 *
 * 用**本地时间**：这个目录名是给用户看的（在文件管理器里翻），"10 月下载的东西在
 * `2026-10` 里"必须与他手表上的日期一致 —— 用 UTC 会让月底 8 小时的文件落进下一个月。
 *
 * ⚠️ 这个时间戳是**归档时间**（第一次落盘那一刻），不是消息的发送时间：我们不读取
 * 页面内部数据（[INV-1]），拿不到消息时间。`capture/download.ts` 把同一个时间戳同时
 * 交给这里与索引，因此两者不会跨月不一致。
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

/** 这一段是不是月份目录（`2026-10`）。`2026-13` / `2026-1` / `2026/10` 都不算。 */
export function isArchiveMonthDir(segment: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(segment)
}

/**
 * [ADR-0037] 那一版的两层容器（`2026/10/`）。
 *
 * 已经落盘的 `2026/10/` 必须在迁移与读取里继续认；新的写入一律用 `2026-10`。
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
 * 三段拼在一起：账号、`files`、月份。旧布局（裸文件名、`2026/10/…`）**不经过这里** ——
 * 它们的相对路径在写入那一刻就定下了，读取时逐字用（[ADR-0037] 的纪律：位置是事实，不反推）。
 */
export function archiveStoredPath(account: string, folder: string, fileName: string): string {
  return `${account}/${FILES_SEGMENT}/${folder}/${fileName}`
}

/**
 * 把索引里那份 `stored_name` 净化成一个**必定落在归档目录内**的相对路径。
 *
 * 允许两种形态：
 *
 *   - 裸文件名           —— [ADR-0031] 到 [ADR-0037] 之间的布局（平面），旧记录都是它
 *   - `年/月/文件名`     —— 现在的布局，以及将来更深的分区（只要没有 `..`）
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
