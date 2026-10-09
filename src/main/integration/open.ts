/**
 * 交给系统默认应用打开 / 在文件管理器中定位。
 *
 * 归档正文以**原文名**落盘（[ADR-0031]），因此这里没有多少事可做：直接对归档目录里那个
 * 文件调用 `shell.openPath` 就行。
 *
 * ⚠️ 曾经不是这样：正文叫 `<sha256>`、**没有扩展名**，而 Linux 上选定打开方式靠 MIME、MIME
 * 首先由**扩展名**推断 —— 于是 `shell.openPath('/…/9f86d081…')` 的结果是"没有可用于打开该
 * 文件的应用"，而文件本身完全正常。当时的解法是造一条
 * `media/.open/<sha256>/报告.pdf` 的硬链接（共享存储，但名字带对扩展名）。
 * 正文带上原名之后，那套影子目录被删掉了（`archive/blobs.ts` 的 `removeLegacyOpenDir()`）。
 *
 * 打开之前会顺手把文件设成**只读**：新写入的文件在提交那一刻就已经是只读的，这里补的是
 * 旧布局（哈希名、非只读）的文件（[ADR-0031]）。
 */

import { existsSync } from 'node:fs'

import { shell } from 'electron'

import type { OpenOutcome, RevealOutcome } from '../../shared/types'
import { archiveFilePath, setReadOnly } from '../archive/blobs'
import { hashPrefix, logger } from '../logger'

/**
 * 交给系统默认应用打开。
 *
 * @param hash 内容哈希。**只用于日志与失败报告**（不用于定位文件）
 * @param storedName 磁盘上的实际文件名，来自 `ArchiveRecord.storedName` 或
 *   `commitFromTemp()` 的返回值。它是**不可信输入的产物**，但已经由 `archive/naming.ts`
 *   净化过，且只在归档目录内拼路径。
 */
export async function openPath(hash: string, storedName: string): Promise<OpenOutcome> {
  const path = archiveFilePath(storedName)
  if (!existsSync(path)) return { ok: false, reason: 'not-found' }

  setReadOnly(path)

  return openRaw(path, hash)
}

/**
 * 在文件管理器中定位归档文件。
 *
 * 对归档而言这一步尤其重要：用户在 `~/Downloads` 里找不到文件，必须有个地方能让他看见它
 * —— 而且文件名是对的（以前那个名字是哈希，或者是一条 `.open/` 里的影子链接）。
 */
export function revealPath(hash: string, storedName: string): RevealOutcome {
  const path = archiveFilePath(storedName)
  if (!existsSync(path)) return { ok: false, reason: 'not-found' }

  try {
    shell.showItemInFolder(path)
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
    // 只记录长度，足以区分"没有关联应用"与"文件不存在"这类情形，又不至于把路径带出去。
    messageLength: message.length,
  })
  return { ok: false, reason: 'no-application' }
}
