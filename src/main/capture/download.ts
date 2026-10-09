/**
 * 接管点 A：下载事件接管。
 *
 * 这是"点击聊天里的文件 → 直接用系统应用打开"的全部实现，也是 M1 的验收目标。
 *
 * 为什么这里能拿到文件：上游点击文档时会构造一个指向 `blob:` 的下载并触发它，
 * 而 Chromium 把**任何** `<a download>` 都送进下载管理器。于是一个内核层的事件
 * 就同时给出了文件名、MIME、字节流与最终状态 —— 不需要任何页面注入。
 *
 * 本模块**不做**的事（分别是 INV-1 / INV-3 的边界）：
 *   - 不解析页面结构、不认识"消息"这个概念
 *   - 不接触密钥、不做解密（流里已经是页面解密后的明文）
 */

import { statSync } from 'node:fs'
import { unlink } from 'node:fs/promises'

import type { DownloadItem, Session } from 'electron'

import { LIMITS } from '../../shared/constants'
import type { Settings } from '../../shared/types'
import {
  blobPath,
  commitFromTemp,
  ensureArchiveDir,
  sweepTempFiles,
  tempPath,
} from '../archive/blobs'
import { archiveStore } from '../archive/store'
import { clearOpenDir, openPath } from '../integration/open'
import { hashPrefix, logger } from '../logger'
import { markCaptured, markFailure } from './health'

export function attachDownloadCapture(ses: Session, getSettings: () => Settings): void {
  ensureArchiveDir()

  // 进程被 kill 会留下半成品。清扫必须在任何新写入之前完成，
  // 否则统计与搜索会把它们当成正常文件。
  const swept = sweepTempFiles()
  if (swept > 0) logger.info('capture: swept leftover temp files', { count: swept })

  // 打开动作会把带原始文件名的硬链接重建一遍，旧链接没有保留价值。
  clearOpenDir()

  ses.on('will-download', (_event, item) => {
    handleDownload(item, getSettings)
  })

  logger.info('capture: download layer attached')
}

function handleDownload(item: DownloadItem, getSettings: () => Settings): void {
  const totalBytes = item.getTotalBytes()

  /**
   * 超大文件不接管，退回上游原生行为。
   *
   * 理由：把 4GB 的视频不经询问地复制进归档，用户不会觉得这是在帮他省事。
   * 这是一次**有意的降级**，因此必须记录，让界面能显示原因。
   */
  if (totalBytes > LIMITS.captureFileBytes) {
    markFailure({ kind: 'too-large', bytes: totalBytes })
    logger.warn('capture: file exceeds capture limit, falling back to native download', {
      bytes: totalBytes,
      limitBytes: LIMITS.captureFileBytes,
    })
    return
  }

  // 先落到归档目录内的临时位置。放在同一目录是为了让最终提交能用 rename 而不是 copy ——
  // 归档目录里因此永远不存在半成品（见 archive/blobs.ts 的注释）。
  const temp = tempPath()
  item.setSavePath(temp)

  const name = item.getFilename()
  const mime = item.getMimeType()

  item.once('done', (_doneEvent, state) => {
    void finalize({ temp, name, mime, state, getSettings })
  })
}

interface FinalizeInput {
  readonly temp: string
  readonly name: string
  readonly mime: string
  readonly state: string
  readonly getSettings: () => Settings
}

async function finalize(input: FinalizeInput): Promise<void> {
  const { temp, name, mime, state } = input

  // 在最终落盘这一刻读设置，而不是在注册时读一份快照 ——
  // 否则用户改了"点击时自动打开"要重启才生效。
  const settings = input.getSettings()

  if (state !== 'completed') {
    await unlink(temp).catch(() => undefined)
    logger.warn('capture: download did not complete', { state })
    return
  }

  let hash: string
  let created: boolean

  try {
    ;({ hash, created } = await commitFromTemp(temp))
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    markFailure({ kind: 'write-failed', reason: (error as Error).name })
    logger.error('capture: failed to commit file into archive', { reason: (error as Error).name })
    return
  }

  /**
   * 索引失败不应阻止打开文件。
   *
   * 用户的诉求是"打开这个文件"，索引是增强。顺序上先保证可用性，
   * 索引的问题记录在日志里，而不是抛出去打断主流程。
   */
  try {
    archiveStore().record({
      hash,
      name,
      bytes: fileSize(hash),
      mime,
      openedAt: Date.now(),
      // chatLabel 刻意留空：我们不读取页面内部数据（INV-1），
      // 因此没有可靠的会话来源。不要为了填上它而引入新的数据源。
    })
  } catch (error) {
    logger.warn('capture: failed to index file', {
      hash: hashPrefix(hash),
      reason: (error as Error).name,
    })
  }

  logger.info('capture: stored', { hash: hashPrefix(hash), mime, deduplicated: !created })

  if (!settings.openOnCapture) {
    markCaptured()
    return
  }

  const outcome = await openPath(hash, name)
  if (!outcome.ok) {
    markFailure({ kind: 'open-failed', reason: outcome.reason })
    logger.warn('capture: open failed', { hash: hashPrefix(hash), reason: outcome.reason })
    return
  }

  markCaptured()
}

function fileSize(hash: string): number {
  try {
    return statSync(blobPath(hash)).size
  } catch {
    return 0
  }
}
