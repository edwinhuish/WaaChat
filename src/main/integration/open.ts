/**
 * 交给系统默认应用打开 / 在文件管理器中定位。
 *
 * ── 为什么不能直接打开归档里的那个文件 ──
 *
 * 归档采用**内容寻址**，也就是说文件名是一串十六进制哈希，**没有扩展名**。
 * 而在 Linux 上选定打开方式靠的是 MIME 类型，MIME 类型首先由**扩展名**推断。
 * 于是 `shell.openPath('/…/9f86d081…')` 的结果是"没有可用于打开该文件的应用"——
 * 而文件本身完全正常。这是内容寻址带来的一个真实副作用，不是理论问题。
 *
 * 解决办法：为打开动作构造一个**带原始文件名**的硬链接，指向同一份数据。
 *
 *   归档正文：  media/<sha256>                  ← 内容寻址，用于去重
 *   打开用的名：media/.open/<sha256>/报告.pdf    ← 硬链接，不额外占空间
 *
 * 硬链接与正文共享存储（因此不浪费空间、也不延迟），但链接名带了正确的扩展名，
 * 于是 MIME 推断与"另存为"对话框里的文件名都恢复正常。
 *
 * 链接放在归档目录内部而不是 XDG_CACHE_HOME，是为了保证与正文**在同一个文件系统**
 * （跨文件系统无法建硬链接，只能退化为真实复制）。
 */

import { existsSync, linkSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { shell } from 'electron'

import type { OpenOutcome, RevealOutcome } from '../../shared/types'
import { blobPath, setReadOnly } from '../archive/blobs'
import { sanitizeFileName } from '../archive/naming'
import { hashPrefix, logger } from '../logger'
import { archiveDir } from '../paths'

/** 打开用的链接目录。名字以点开头，因此不会被归档统计与搜索看到（见 blobs.ts 的 usage）。 */
const OPEN_DIR_NAME = '.open'

const DIR_MODE = 0o700

/** 打开用的链接路径：每个内容哈希一个子目录，避免同名文件互相覆盖。 */
export function openLinkPath(hash: string, name: string): string {
  return join(archiveDir(), OPEN_DIR_NAME, hash, sanitizeFileName(name))
}

/**
 * 清空链接目录。
 *
 * 在启动时调用一次即可。链接是**派生物**：删掉不影响归档，下次打开会重建。
 * 保留它们没有任何好处，而清掉能避免"上一次会话留下的链接指向已被淘汰的内容"。
 */
export function clearOpenDir(): void {
  try {
    rmSync(join(archiveDir(), OPEN_DIR_NAME), { recursive: true, force: true })
  } catch (error) {
    logger.warn('open: failed to clear link directory', { reason: (error as Error).name })
  }
}

/**
 * 确保"带原始文件名的入口"存在，返回它的路径；失败返回 `null`。
 *
 * 打开与"在文件夹中显示"都需要这个入口，因此这里只负责**建好它**，
 * 由调用方决定拿它去做什么。返回 `null` 而非抛错，是因为两种调用方都能降级：
 * 打开可以退回哈希名文件，显示位置则可以放弃。
 */
export function ensureOpenLink(hash: string, name: string): string | null {
  const blob = blobPath(hash)
  if (!existsSync(blob)) return null

  const target = openLinkPath(hash, name)

  try {
    mkdirSync(dirname(target), { recursive: true, mode: DIR_MODE })

    // 链接已存在且指向同一份内容就复用。用 inode 判断，而不是"存在即复用"——
    // 归档被淘汰后重建会得到同样的哈希名但不同的 inode，此时旧链接是悬空的。
    const reusable = existsSync(target) && statSync(target).ino === statSync(blob).ino

    if (!reusable) {
      rmSync(target, { force: true })
      linkSync(blob, target)
    }

    return target
  } catch (error) {
    // 建链接失败（极端情况下可能是跨文件系统）不该让用户打不开文件：
    // 调用方会退回哈希名路径，行为降级但可用，并把原因记下来。
    logger.warn('open: could not create named link', {
      hash: hashPrefix(hash),
      reason: (error as Error).name,
    })
    return null
  }
}

/**
 * 构造（或复用）一个带原始文件名的入口，然后交给系统打开。
 *
 * @param hash 内容哈希（归档中的文件名）
 * @param name 原始文件名，仅用于构造链接名；不可信输入，由 naming.ts 净化
 */
export async function openPath(hash: string, name: string): Promise<OpenOutcome> {
  const blob = blobPath(hash)
  if (!existsSync(blob)) return { ok: false, reason: 'not-found' }

  // 旧布局（哈希名）的文件在第一次被打开时补上只读：新写入的文件在提交那一刻就已经是
  // 只读的，而"用户真正用到的旧文件"才是这里值得顺手收紧的那些（[ADR-0031]）。
  setReadOnly(blob)

  return openRaw(ensureOpenLink(hash, name) ?? blob, hash)
}

/**
 * 在文件管理器中定位归档文件。
 *
 * 对于"内容寻址"的归档来说这一步尤其重要：用户在 `~/Downloads` 里找不到文件，
 * 必须有个地方能让他看见它 —— 而且**文件名是正确的**，否则他会看到一个哈希。
 */
export function revealPath(hash: string, name: string): RevealOutcome {
  if (!existsSync(blobPath(hash))) return { ok: false, reason: 'not-found' }

  const target = ensureOpenLink(hash, name)
  if (target === null) return { ok: false, reason: 'failed' }

  try {
    shell.showItemInFolder(target)
    return { ok: true }
  } catch (error) {
    logger.warn('open: could not reveal item', {
      hash: hashPrefix(hash),
      reason: (error as Error).name,
    })
    return { ok: false, reason: 'failed' }
  }
}

/**
 * `shell.openPath` 在失败时**返回错误消息字符串**（成功时是空串），并不抛异常。
 * 忘了检查返回值是最常见的写法错误，症状是"点了没反应也没有日志"。
 *
 * ⚠️ 那个错误消息可能包含**完整路径与文件名**（例如 "No application found for
 * /home/edwin/…/客户合同.pdf"），因此**绝不能**把它写进日志 —— 见
 * `ai/INVARIANTS.md` G-3。这里只记录它非空这个事实。
 */
async function openRaw(path: string, hash: string): Promise<OpenOutcome> {
  const message = await shell.openPath(path)

  if (message === '') return { ok: true }

  logger.warn('open: shell rejected the path', {
    hash: hashPrefix(hash),
    // 只记录长度与首行长度，足以区分"没有关联应用"与"文件不存在"这类情形，
    // 又不至于把路径带出去。
    messageLength: message.length,
  })
  return { ok: false, reason: 'no-application' }
}
