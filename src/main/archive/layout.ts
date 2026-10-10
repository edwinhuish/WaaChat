/**
 * 归档目录的**时间分区**（[ADR-0037]）。
 *
 * 归档正文落在 `<归档目录>/<年>/<月>/<文件名>`：
 *
 *   ~/Documents/WaaChat_files/2026/10/2026年第三季度采购合同.pdf
 *
 * 为什么值得一个独立模块（与 `naming.ts` 同样的理由）：这里是**纯函数**
 * —— 不碰文件系统、不导入 electron、不认识 SQLite —— 因此"年月怎么算""什么样的
 * 相对路径算安全"能被单测直接覆盖，而这两件事都错得很安静：
 *
 *   - **年月算错**（用 UTC 而不是本地时间、月份从 0 开始忘了 +1）：文件落进相邻的
 *     月份目录，用户不会发现，但"按时间翻文件夹"从此不可信。
 *   - **相对路径不净化**：`stored_name` 来自索引（我们自己的数据），但它一旦被手工
 *     改坏、或将来换了写入方，`join(归档目录, stored_name)` 就是一个路径穿越点。
 *
 * 目录层级只有两级（年 / 月），这个深度是**判据**而不是巧合：`archive/migrate.ts` 用
 * {@link isArchiveYear} / {@link isArchiveMonth} 把"年月容器"与"这个位置被别的东西用了"
 * 分开，多出来的层级会被当成异常内容（迁移直接失败）而不是被默默搬走。
 */

/**
 * 归档时间（Unix 毫秒）落在哪个年月目录。
 *
 * 用**本地时间**：这个目录名是给用户看的（在文件管理器里翻），"10 月下载的东西在
 * `2026/10` 里"必须与他手表上的日期一致 —— 用 UTC 会让月底 8 小时的文件落进下一个月。
 *
 * ⚠️ 这个时间戳是**归档时间**（第一次落盘那一刻），不是消息的发送时间：我们不读取
 * 页面内部数据（[INV-1]），拿不到消息时间。`capture/download.ts` 把同一个时间戳同时
 * 交给这里与索引，因此两者不会跨月不一致。
 *
 * 非有限值（`NaN` / `Infinity`）直接抛：它是调用方的编程错误，而"返回一个荒唐的
 * `NaN/NaN` 目录名"会让错误变成一个悄悄建出来的怪目录。
 */
export function folderFor(openedAt: number): string {
  if (!Number.isFinite(openedAt)) throw new TypeError('archive: openedAt must be a finite number')

  const date = new Date(openedAt)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')

  return `${year}/${month}`
}

/** 这一段是不是我们建的年份目录。判据是形状，不是"它存在"——用于迁移时识别自己的容器。 */
export function isArchiveYear(segment: string): boolean {
  return /^\d{4}$/.test(segment)
}

/** 这一段是不是合法的月份目录（`01`–`12`）。`13` / `00` / `1` 都不算。 */
export function isArchiveMonth(segment: string): boolean {
  return /^(0[1-9]|1[0-2])$/.test(segment)
}

/** 年月目录内的**相对**路径，写进索引的 `stored_name` 与 `ArchiveRecord.storedName`。 */
export function archiveRelativePath(folder: string, fileName: string): string {
  return folder === '' ? fileName : `${folder}/${fileName}`
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
