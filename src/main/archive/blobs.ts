/**
 * 归档正文的落盘。
 *
 * ── 命名：原文名，不是哈希 ──
 *
 * 哈希（SHA-256）是这份内容的**身份**，用于索引里去重与查找；而**磁盘上的名字**是净化后的
 * 原文名（`2026年第三季度合同.pdf`），这样归档目录在文件管理器里可以直接看、直接用
 * （[ADR-0031]）。
 *
 * 两件事分别由两处决定：
 *
 *   1. **同名不同内容**（两个对端各发一份 `合同.pdf`）：按 `naming.ts` 的候选名依次尝试
 *      （原名 → 带一小段哈希 → 带完整哈希），取第一个可用的。确定性，不扫描目录。
 *   2. **同一份内容**：只存一份。名字相同时丢掉临时文件；名字不同时给已有内容**再挂一个
 *      名字**（硬链接，不额外占字节）。因此 `usage()` 必须按 inode 去重统计。
 *
 * ── 落进哪一层：年 / 月 ──
 *
 * 正文落在 `<归档目录>/<年>/<月>/`（[ADR-0037]），这两个目录由 `ensureArchiveFolder()`
 * 按需创建并收到 `0700`。**同名的判据因此变成"同一个年月目录内"**：`合同.pdf` 在
 * `2026/09` 与 `2026/10` 各有一份互不干扰 —— 跨月不再需要哈希后缀，这是分区带来的好处；
 * 而同一份内容跨月出现时仍然是硬链接（不同目录、同一个 inode），占用不变。
 *
 * 临时文件**始终落在归档目录根**：`rename` 要求同一文件系统（根与年月子目录必然同盘），
 * 而 `sweepTempFiles()` 因此不必递归。
 *
 * ── 顺序 ──
 *
 * 算哈希 → 决定名字 → 原子改名（rename，不是 copy）→ 置为只读。用 rename 是为了让归档
 * 目录里**永远不存在半成品**：要么文件不存在，要么它是完整的。前提是临时文件与目标在同一
 * 个文件系统上（因此 `tempPath()` 也落在归档目录内）。
 *
 * 本模块不导入 electron，也不导入 `archive/store.ts`（后者是原生模块，且方向是 store → blobs）：
 * 其中的哈希与路径推导逻辑需要被单测覆盖。
 */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { TEMP_FILE_PREFIX } from '../../shared/constants'
import { hashPrefix, logger, redactPath } from '../logger'
import { accountKey, archiveDir } from '../paths'
import { FILES_SEGMENT, archiveStoredPath, folderFor, normalizeStoredPath } from './layout'
import { archiveNameCandidates } from './naming'

/** 归档目录权限：仅本人可读写执行。里面的文件是**解密后的明文**。 */
const DIR_MODE = 0o700

/**
 * 建目录并确保权限是 0700。幂等。
 *
 * 必须在目录**已存在**时也收紧权限，而不是只靠 `mkdir` 的 `mode`：
 * `mkdirSync` 的 mode 只对新建的目录生效，而这些目录都可能先被用户建好 ——
 * 归档位置就在 `~/Documents` 下，用户完全可能自己先建好了它（权限通常是 0755），
 * 年月子目录同理（例如他从别处拷来一棵同名目录树）。那条路径上"目录必须 0700"会
 * **静默失效**，而里面是解密后的明文。
 */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })

  try {
    if ((statSync(dir).mode & 0o777) === DIR_MODE) return

    chmodSync(dir, DIR_MODE)
    logger.info('archive: tightened directory permissions', { dir: redactPath(dir) })
  } catch (error) {
    // 收紧失败不阻断启动（用户可能把归档放在一个不支持权限位的文件系统上），
    // 但必须留痕：静默地以更宽的权限运行正是这里要防的事。
    logger.warn('archive: could not tighten directory permissions', {
      dir: redactPath(dir),
      reason: (error as Error).name,
    })
  }
}

/** 确保归档根目录存在，权限正确。幂等。 */
export function ensureArchiveDir(): void {
  ensureDir(archiveDir())
}

/**
 * 确保归档目录里的某个**容器**（相对路径，如 `<账号>/files/2026-10`）存在，权限正确（`0700`）。
 * 幂等。
 *
 * 只由落盘路径调用（[ADR-0037] / [ADR-0039]）。它**不做净化**：这里的输入全部由我们自己
 * 拼出来（账号名已由 `paths.normalizeAccountKey()` 净化过、月份由 `folderFor()` 生成），
 * 若它不成形，说明调用方写错了 —— 那时 `mkdir` 会老老实实建出一个怪目录，比抛错更难查。
 */
export function ensureArchiveFolder(folder: string): void {
  ensureDir(archiveFilePath(folder))
}

/**
 * 归档目录里某个文件（或年月子目录）的完整路径。
 *
 * @param storedName 相对归档目录的**路径**：现在是 `年/月/文件名`
 *   （如 `2026/10/合同.pdf`，[ADR-0037]），旧记录是裸文件名（原文名 / 内容哈希）。
 *   两种形态都对，因为这里做的就是把它接到归档目录后面。调用方从
 *   `ArchiveRecord.storedName` 或 `commitFromTemp()` 的返回值拿到它。
 */
export function archiveFilePath(storedName: string): string {
  const relative = normalizeStoredPath(storedName)

  /**
   * 净化之后什么都不剩（空串、`.`、`..`）：返回一个归档目录里**不可能存在**的名字，
   * 而不是归档目录本身 —— 后者会让 `existsSync()` 判为真，把"打开这个文件"变成
   * "用文件管理器打开整个归档目录"。点开头保证它不会被 `usage()` 当成正文。
   */
  if (relative === '') return join(archiveDir(), INVALID_STORED_PATH)

  return join(archiveDir(), relative)
}

/** 净化后什么都不剩时用的占位名。见 `archiveFilePath()`。 */
const INVALID_STORED_PATH = '.invalid-stored-name'

/** 旧版本的影子目录（[ADR-0031] 之前为"带原始文件名的硬链接"而建）。 */
const LEGACY_OPEN_DIR_NAME = '.open'

/**
 * 清掉旧版本的影子目录 `.open/`。
 *
 * [ADR-0031] 之前正文以哈希命名、没有扩展名，为了能交给系统应用打开才需要一条带原始文件名
 * 的硬链接；现在正文本身就是原名，那套东西不再需要。它是**派生物**（删掉不影响归档），
 * 而里面那些硬链接会让"文件看起来还在占空间"。删不掉只记日志 —— 不影响任何功能。
 */
export function removeLegacyOpenDir(): void {
  try {
    rmSync(join(archiveDir(), LEGACY_OPEN_DIR_NAME), { recursive: true, force: true })
  } catch (error) {
    logger.warn('archive: failed to remove the legacy link directory', {
      reason: (error as Error).name,
    })
  }
}

/**
 * 归档正文的权限位：**只读**（[ADR-0031]）。
 *
 * 归档是内容寻址的：一份内容对应多条索引记录，而索引里记着它的哈希。文件被**就地**改一个
 * 字节，那份哈希就与内容不再相符 —— 症状是"搜索命中，但打开后不是当初那份文件"，而且
 * 没有任何地方会报错。只读把这条不变量交给文件系统，而不是靠用户自觉。
 *
 * 它挡的只是"就地改内容"：**删除与迁移不受影响**（两者只依赖目录的写权限，见 `wipeArchive()`
 * 与 `archive/migrate.ts`）。`0400` 而不是 `0444`：归档目录本身是 `0700`，两者在暴露面上
 * 没有区别，而 `0400` 与既有的"仅本人可读"一脉相承。
 */
export const ARCHIVE_FILE_MODE = 0o400

/**
 * 把一份归档正文设为只读。幂等；失败只记日志。
 *
 * 失败不阻断任何事：用户可能把归档放在不支持权限位的文件系统上（与 `ensureArchiveDir()`
 * 同样的处理），而"打不开文件"比"文件可写"严重得多。
 *
 * 旧布局（哈希名、非只读）的文件在**它被打开时**补上（`integration/open.ts`），而不是启动时
 * 对全库做一次 `chmod`：上万条目时那是一次全量 IO，而真正值得收紧的是用户实际用到的那些。
 */
export function setReadOnly(path: string): void {
  try {
    if ((statSync(path).mode & 0o777) === ARCHIVE_FILE_MODE) return
    chmodSync(path, ARCHIVE_FILE_MODE)
  } catch (error) {
    logger.warn('archive: could not make a file read-only', { reason: (error as Error).name })
  }
}

/** 生成一个位于归档目录内的随机临时路径。 */
export function tempPath(): string {
  const random = Math.random().toString(36).slice(2, 10)
  return join(archiveDir(), `${TEMP_FILE_PREFIX}${Date.now()}-${random}`)
}

/** 流式计算 SHA-256。大文件不整块读进内存。 */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)

    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export interface CommitResult {
  readonly hash: string
  /**
   * 磁盘上的实际路径**相对归档目录**：`年/月/文件名`
   * （如 `2026/10/合同.pdf`；同名冲突时文件名带一小段哈希后缀，[ADR-0031] / [ADR-0037]）。
   */
  readonly storedName: string
  readonly bytes: number
  /**
   * false 表示这次**没有写入新字节**：同内容同名字（去重命中），或同一份内容换了名字
   * （给它挂了一个硬链接）。两种情况都不会让归档变大。
   */
  readonly created: boolean
}

export interface CommitOptions {
  /**
   * 内容哈希已知时，它在归档里的**相对路径**；不知道（或索引里没有）则返回 `null`。
   *
   * **注入**而不是直接查索引：`archive/` 内部的方向是 `store → blobs`，反过来 import 会成环
   * （`store.ts` 要 import 这里的 `ensureArchiveDir` 与 `usage`）。
   */
  readonly findStored?: (hash: string) => string | null

  /**
   * 归档时间（Unix 毫秒），决定文件落在哪个年月子目录（[ADR-0037]）。默认"现在"。
   *
   * ⚠️ 调用方**必须**把同一个值交给索引（`store.record({ openedAt })`）：两处各取一次
   * 时钟，跨月的那一毫秒就会得到"索引说 10 月、文件在 9 月"。
   */
  readonly openedAt?: number
}

/**
 * 把临时文件提交进归档：落在 `<归档目录>/<年>/<月>/`，文件名用**原文名**（[ADR-0031]）。
 *
 * 顺序不要重排：
 *
 *   算哈希 → 定年月目录与名字 → 内容已在归档就走"丢弃临时文件 / 挂一个新名字"
 *   → 否则原子改名 → 置只读
 *
 * 用 rename 而不是 copy，是为了让归档目录里**永远不存在半成品**：要么文件不存在，要么它是
 * 完整的。前提是临时文件与目标在同一个文件系统上 —— 临时文件始终在归档目录**根**，而年月
 * 子目录是它的下级，因此这个前提由构造保证。
 *
 * @param temp 位于归档目录内的临时文件（`capture/download.ts` 下载时指定）
 * @param rawName 打开时的原始文件名，**不可信输入**（由对端发送者决定），由 `naming.ts` 净化
 */
export async function commitFromTemp(
  temp: string,
  rawName: string,
  options: CommitOptions = {},
): Promise<CommitResult> {
  const hash = await sha256File(temp)
  const bytes = statSync(temp).size

  const account = accountKey()
  const folder = folderFor(options.openedAt ?? Date.now())

  // 容器链一次建齐：`<账号>/files/<年-月>`（[ADR-0039]）。`rename` 不会建目录，
  // 因此这一步必须在落盘之前 —— 权限同样是 0700（见 ensureDir 里那段说明）。
  ensureArchiveFolder(`${account}/${FILES_SEGMENT}/${folder}`)

  // 同一份内容可能已经在归档里（可能叫别的名字、可能在别的月份、也可能在别的账号目录下）——
  // 那就只多挂一个名字，不再写一份字节。
  const existing = findExisting(hash, bytes, options)

  for (const candidate of archiveNameCandidates(rawName, hash)) {
    const storedName = archiveStoredPath(account, folder, candidate)
    const target = archiveFilePath(storedName)

    if (existsSync(target)) {
      // 这个名字被占着：内容相同就是"已经存过"（去重），不同就试下一个候选名。
      if (await sameContent(target, hash, bytes)) {
        await unlink(temp)
        return { hash, storedName, bytes, created: false }
      }

      continue
    }

    if (existing !== null) {
      // 内容在归档里、只是叫别的名字：挂一个硬链接。多一个名字，不多占字节。
      linkSync(existing, target)
      setReadOnly(target)
      await unlink(temp)
      return { hash, storedName, bytes, created: false }
    }

    renameSync(temp, target)

    // 改名之后再收紧权限：名字在改名那一刻就是最终形态，而权限位与内容无关，
    // 因此中间没有可被观察到的坏状态（[ADR-0031]）。
    setReadOnly(target)

    return { hash, storedName, bytes, created: true }
  }

  /**
   * 候选名全被别的内容占着 —— 理论上不可能（最后一个候选带完整哈希）。
   *
   * 因此当成一次写入失败报出去，而**不删**临时文件：调用方（`capture/download.ts`）负责在
   * 失败路径上清掉它。日志里只出现哈希前缀，文件名不进日志（INVARIANTS G-3）。
   */
  throw new Error(`archive: no free name for ${hashPrefix(hash)}`)
}

/**
 * 磁盘上已有的、内容为 `hash` 的那份文件（绝对路径）；不确定时返回 `null`。
 *
 * 先用索引给的线索（相对路径，可能落在别的年月目录里），再确认那个文件还在、**大小也对得上**
 * —— 索引可能指向一个已被删除或已被替换的文件，那时去 link 会得到一个错的链接或 `ENOENT`。
 * 只比大小是够的：为"索引过期"这种情形每次下载都把整个文件哈希一遍不值得。
 */
function findExisting(hash: string, bytes: number, options: CommitOptions): string | null {
  const hinted = options.findStored?.(hash)
  if (hinted === undefined || hinted === null) return null

  try {
    const stat = statSync(archiveFilePath(hinted))
    return stat.isFile() && stat.size === bytes ? archiveFilePath(hinted) : null
  } catch {
    return null
  }
}

/**
 * 磁盘上那个文件是不是这份内容。
 *
 * 先比大小：不同大小一定不是同一份内容（"同名但不是同一个文件"的绝大多数情况，一次 stat
 * 就够了），大小相同才去算哈希。
 */
async function sameContent(path: string, hash: string, bytes: number): Promise<boolean> {
  try {
    if (statSync(path).size !== bytes) return false
  } catch {
    return false
  }

  return (await sha256File(path)) === hash
}

/**
 * 清扫残留的临时文件。
 *
 * 进程被 kill 会留下它们。应在启动时调用一次。
 * 返回清掉的数量，便于日志确认。
 *
 * 只看归档目录**根**：临时文件永远落在这里（年月子目录里不会出现 `.part-*`，
 * 见 `tempPath()` 与 `commitFromTemp()`），因此不必递归。
 */
export function sweepTempFiles(): number {
  ensureArchiveDir()
  let removed = 0

  for (const entry of readdirSync(archiveDir())) {
    if (!entry.startsWith(TEMP_FILE_PREFIX)) continue
    try {
      unlinkSync(join(archiveDir(), entry))
      removed += 1
    } catch {
      // 被其它进程占用就跳过，不值得为此中断启动。
    }
  }

  return removed
}

/**
 * 归档当前占用的字节数与文件数。
 *
 * **按 inode 去重**：同一份内容可以有多个名字（硬链接，[ADR-0031]），按名字累加会让占用翻倍
 * —— `.open/` 时代就已经是这条纪律。因此这里的 `files` 是"磁盘上真实占用的文件数"，
 * 与索引里的记录条数不是一回事。
 */
export function usage(): { bytes: number; files: number } {
  ensureArchiveDir()
  let bytes = 0
  const inodes = new Set<number>()

  /**
   * 递归：正文现在在 `<年>/<月>/` 里（[ADR-0037]）。
   *
   * 跳过点开头的条目（`.part-*` 半成品、`.index.sqlite*` 索引、旧版 `.open/`）与符号链接
   * （INVARIANTS G-4：归档目录内不跟随符号链接）。inode 集合**跨目录**共用 —— 硬链接可以
   * 指向另一个年月目录里的正文，按目录分别去重会让占用翻倍。
   */
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        walk(join(dir, entry.name))
        continue
      }

      try {
        const stat = statSync(join(dir, entry.name))
        if (inodes.has(stat.ino)) continue

        inodes.add(stat.ino)
        bytes += stat.size
      } catch {
        // 统计失败不应影响主流程。
      }
    }
  }

  walk(archiveDir())

  return { bytes, files: inodes.size }
}

/**
 * 清空归档目录。
 *
 * 只由 `wipeArchiveOnExit` 触发（`src/main/index.ts` 的 `before-quit`）。
 *
 * ⚠️ 这个函数**只**允许碰归档目录。[ADR-0008] 把登录态（会话分区）与归档（用户资产）
 * 分开存放，就是为了让"清理"这类功能在**文件系统层面**不可能走到登录态
 * —— 而不是靠调用方记得别传错路径。删掉登录态意味着用户要重新扫码，
 * 而这是不可从错误中恢复的那一类后果。
 *
 * 用同步删除：`before-quit` 之后进程随时可能退出，异步删除可能来不及完成。
 */
export function wipeArchive(): number {
  ensureArchiveDir()
  let removed = 0

  for (const entry of readdirSync(archiveDir())) {
    // 连残留的 `.part-*`、旧版本的 `.open/` 与年月子目录一起清掉：前两者是派生物，
    // 后者是正文的容器 —— 清空归档就是连容器一起清。
    try {
      rmSync(join(archiveDir(), entry), { recursive: true, force: true })
      removed += 1
    } catch {
      // 单个条目删不掉不该阻断退出流程。
    }
  }

  return removed
}

/**
 * 按最久未访问优先淘汰，直到占用不超过上限。
 *
 * 返回被删掉的文件哈希列表，供调用方同步清理索引 —— **索引不清理会留下悬空记录**，
 * 表现为"搜得到但打不开"。这一步的返回值不能被忽略。
 *
 * TODO(M2)：实现。需要与 archive/store.ts 配合，避免删掉索引中仍被引用的文件。
 * 当前是**空实现**，因此 `archiveMaxBytes` 现在不生效 —— 界面上的对应项应显示为
 * "尚未启用"，而不是假装有效（见 docs/roadmap.md M2）。
 */
export function evictToFit(_maxBytes: number): string[] {
  return []
}
