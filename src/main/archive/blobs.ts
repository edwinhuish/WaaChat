/**
 * 内容寻址存储。
 *
 * 核心思想：用内容的 SHA-256 作为文件名。由此得到两个**免费**的性质：
 *
 *   1. 去重不需要任何判断逻辑 —— 同一份内容必然同名。文件名上的差异
 *      （`报告.pdf` / `报告 (1).pdf`）不会产生新的存储。
 *   2. "文件是否已存在"变成一个廉价问题 —— 先算哈希，命中就丢掉临时文件。
 *
 * 本模块不导入 electron，因为其中的哈希与路径推导逻辑需要被单测覆盖。
 * 文件系统的写入约定见下方 commitFromTemp 的注释。
 */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  existsSync,
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
import { logger, redactPath } from '../logger'
import { archiveDir } from '../paths'

/** 归档目录权限：仅本人可读写执行。里面的文件是**解密后的明文**。 */
const DIR_MODE = 0o700

/**
 * 确保归档目录存在，权限正确。幂等。
 *
 * 必须在目录**已存在**时也收紧权限，而不是只靠 `mkdir` 的 `mode`：
 * `mkdirSync` 的 mode 只对新建的目录生效，而归档位置是用户可配的 ——
 * 默认位置就在 `~/Documents` 下，用户完全可能自己先建好了那个目录（权限通常是 0755）。
 * 那条路径上"目录必须 0700"会**静默失效**，而里面是解密后的明文。
 */
export function ensureArchiveDir(): void {
  const dir = archiveDir()
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

/** 内容哈希对应的归档路径。 */
export function blobPath(hash: string): string {
  return join(archiveDir(), hash)
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
  /** false 表示内容已存在，临时文件已被丢弃（去重命中）。 */
  readonly created: boolean
}

/**
 * 把临时文件提交进归档。
 *
 * 顺序是有讲究的，不要重排：
 *
 *   算哈希 → 命中则丢弃临时文件 → 否则**原子改名**（rename，不是 copy）
 *
 * 用 rename 而不是 copy，是为了让归档目录里**永远不存在半成品**：要么文件不存在，
 * 要么它是完整的。copy 会产生一个可被观察到的中间态。
 *
 * 前提：临时文件与目标必须在同一个文件系统上（因此 tempPath 也落在归档目录内）。
 */
export async function commitFromTemp(temp: string): Promise<CommitResult> {
  const hash = await sha256File(temp)
  const target = blobPath(hash)

  if (existsSync(target)) {
    await unlink(temp)
    return { hash, created: false }
  }

  renameSync(temp, target)
  return { hash, created: true }
}

/**
 * 清扫残留的临时文件。
 *
 * 进程被 kill 会留下它们。应在启动时调用一次。
 * 返回清掉的数量，便于日志确认。
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

/** 归档当前占用的总字节数与文件数。 */
export function usage(): { bytes: number; files: number } {
  ensureArchiveDir()
  let bytes = 0
  let files = 0

  for (const entry of readdirSync(archiveDir())) {
    // 跳过所有点开头的条目：`.part-*` 是半成品，`.open/` 是为打开而建的硬链接目录
    // （硬链接与正文共享存储，把它算进来会让统计翻倍）。
    if (entry.startsWith('.')) continue
    try {
      bytes += statSync(join(archiveDir(), entry)).size
      files += 1
    } catch {
      // 统计失败不应影响主流程。
    }
  }

  return { bytes, files }
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
    // 连 `.open/` 与残留的 `.part-*` 一起清掉：它们都是派生物。
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
