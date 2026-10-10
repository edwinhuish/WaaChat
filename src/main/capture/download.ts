/**
 * 接管点 A：下载事件接管。
 *
 * 这是"点击聊天里的文件 → 直接用系统应用打开"的全部实现，也是 M1 的验收目标。
 *
 * 为什么这里能拿到文件：上游点击文档时会构造一个指向 `blob:` 的下载并触发它，
 * 而 Chromium 把**任何** `<a download>` 都送进下载管理器。于是一个内核层的事件
 * 就同时给出了文件名、MIME、字节流与最终状态 —— 不需要任何页面注入。
 *
 * 本模块**不做**的事（INV-3 的边界）：
 *   - 不接触密钥、不做解密（流里已经是页面解密后的明文）
 *
 * ⚠️ 它**会**向页面问两件事，都只读消息模型上的字段、**不解析 DOM、不驱动页面动作**；
 * INV-1 已由 [ADR-0043] 撤销，这些注入点沿用 [ADR-0046] 的方式（主进程
 * `executeJavaScript`，不给窗口加 preload）：
 *
 *   1. **点击那一刻**：这条内容在归档里吗（按"文件名 + 大小"问 `filehash`，[ADR-0047]）。
 *   2. **落盘那一刻**：这条文件属于哪条消息（按刚算出的内容哈希反查 `msg.id`，[ADR-0052]）
 *      —— 归档路径 `<账号>/<消息ID>/files/` 需要它。
 */

import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'

import type { DownloadItem, Session, WebContents } from 'electron'

import { LIMITS } from '../../shared/constants'
import type { Settings } from '../../shared/types'
import {
  archiveFilePath,
  commitFromTemp,
  ensureArchiveDir,
  removeLegacyOpenDir,
  sweepTempFiles,
  tempPath,
} from '../archive/blobs'
import { archiveStore, enforceArchiveLimit } from '../archive/store'
import { failureReason } from '../errors'
import { openPath } from '../integration/open'
import { hashPrefix, logger } from '../logger'
import {
  encodeFilehash,
  pageLookupExpression,
  pageMessageIdExpression,
  pickContentHash,
  pickMessageId,
} from './early-identity'
import { markCaptured, markFailure } from './health'

export function attachDownloadCapture(ses: Session, getSettings: () => Settings): void {
  ensureArchiveDir()

  // 进程被 kill 会留下半成品。清扫必须在任何新写入之前完成，
  // 否则统计与搜索会把它们当成正常文件。
  const swept = sweepTempFiles()
  if (swept > 0) logger.info('capture: swept leftover temp files', { count: swept })

  // 旧版本的 `.open/` 影子目录（为"带原始文件名的硬链接"而建）不再使用，启动时清一次：
  // 里面那些链接会让"文件看起来还在占空间"（[ADR-0031]）。
  removeLegacyOpenDir()

  // 启动时按当前上限淘汰一次（[ADR-0048]）：上次退出时可能超额，而用户下次设了更小的
  // 上限、又没再下载任何东西的话，占用会一直停在旧值上 —— 那看起来像设置没生效。
  enforceLimit(getSettings)

  ses.on('will-download', (_event, item, contents) => {
    handleDownload(item, getSettings, contents)
  })

  logger.info('capture: download layer attached')
}

/**
 * 按设置里的上限淘汰一次（[ADR-0048]）。
 *
 * 失败只记日志：淘汰是维护动作，不该让它打断一次落盘或一次打开（`enforceArchiveLimit()`
 * 本身也不抛错）。`records` 是被删掉的**索引记录**条数。
 */
function enforceLimit(getSettings: () => Settings): void {
  const records = enforceArchiveLimit(getSettings().archiveMaxBytes)
  if (records > 0) logger.info('capture: archive limit enforced', { records })
}

function handleDownload(
  item: DownloadItem,
  getSettings: () => Settings,
  contents: WebContents,
): void {
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

  // 先落到归档目录**根**下的临时位置。留在根上是为了让最终提交能用 rename 而不是 copy
  // （年月子目录是它的下级，必然同盘）—— 归档目录里因此永远不存在半成品
  // （见 archive/blobs.ts 的注释）。
  const temp = tempPath()
  item.setSavePath(temp)

  const name = item.getFilename()
  const mime = item.getMimeType()

  /**
   * 命中归档时会**作废这次下载**（H1）。标志必须在 `cancel()` 之前置上 —— `done` 是异步来的，
   * 慢一步只会退化成今天的行为（多一次复制 + 去重），不会出错。
   */
  let shortCircuited = false

  item.once('done', (_doneEvent, state) => {
    if (shortCircuited) {
      void unlink(temp).catch(() => undefined)
      return
    }
    void finalize({ temp, name, mime, state, contents, getSettings })
  })

  void tryOpenFromArchive({
    item,
    contents,
    name,
    bytes: totalBytes,
    getSettings,
    onHit: () => {
      shortCircuited = true
    },
  })
}

/** 问页面的超时。超了就回落 —— 这条路线只该让点击更快或不变，不该让它变慢。 */
const EARLY_LOOKUP_TIMEOUT_MS = 500

interface EarlyLookupInput {
  readonly item: DownloadItem
  readonly contents: WebContents
  readonly name: string
  readonly bytes: number
  readonly getSettings: () => Settings
  /** 命中且真的要作废这次下载时先叫一声（见 `handleDownload` 里的标志）。 */
  readonly onHit: () => void
}

/**
 * H1：下载前用页面的内容哈希查归档，命中就打开本地那份、作废这次下载（[ADR-0047]）。
 *
 * 三处刻意保守：
 *  1. **只在 `openOnCapture` 开着时做** —— 关着时用户的意思是"只归档、不自动打开"，
 *     替他把已有的那份打开等于改写了那个设置的含义。
 *  2. **只对还在进行中的下载动手**：慢一步时 `done` 已经跑完 `finalize()`，
 *     再打开一次就会**开两遍**。
 *  3. **任何一步拿不准就返回**（查不到 / 值不合法 / 归档里大小对不上）—— 一律回落，
 *     用户看到的仍是今天的行为。
 */
async function tryOpenFromArchive(input: EarlyLookupInput): Promise<void> {
  if (!input.getSettings().openOnCapture) return
  if (input.bytes <= 0) return
  if (input.contents.isDestroyed()) return

  const hash = await askPageForContentHash(input.contents, input.name, input.bytes)
  if (hash === null) return

  if (input.item.getState() !== 'progressing') return

  const storedName = findArchivedByHash(hash, input.bytes)
  if (storedName === null) return

  const outcome = await openPath(hash, storedName)
  if (!outcome.ok) {
    markFailure({ kind: 'open-failed', reason: outcome.reason })
    logger.warn('capture: opening the archived copy failed', {
      hash: hashPrefix(hash),
      reason: outcome.reason,
    })
    return
  }

  input.onHit()
  input.item.cancel()
  markCaptured()
  logger.info('capture: opened the archived copy, cancelled the download', {
    hash: hashPrefix(hash),
  })
}

async function askPageForContentHash(
  contents: WebContents,
  name: string,
  bytes: number,
): Promise<string | null> {
  try {
    const reply = await withTimeout<unknown>(
      contents.executeJavaScript(pageLookupExpression(name, bytes), true) as Promise<unknown>,
      EARLY_LOOKUP_TIMEOUT_MS,
    )
    return pickContentHash(reply)
  } catch (error) {
    logger.warn('capture: early identity lookup failed', { reason: failureReason(error) })
    return null
  }
}

/**
 * 问页面"这条文件属于哪条消息"（[ADR-0052]），拿不到返回 `null`。
 *
 * 与 {@link askPageForContentHash} 同样保守：页面销毁、哈希不是合法 hex、注入超时、
 * 值不唯一 —— 任何一步不成立都返回 `null`，由归档层回落到 `unknown-message`。
 * **这条路线允许失败，不允许分错消息**（分错 = 文件落进别人的消息目录）。
 */
async function askPageForMessageId(contents: WebContents, hash: string): Promise<string | null> {
  const filehash = encodeFilehash(hash)
  if (filehash === null || contents.isDestroyed()) return null

  try {
    const reply = await withTimeout<unknown>(
      contents.executeJavaScript(pageMessageIdExpression(filehash), true) as Promise<unknown>,
      EARLY_LOOKUP_TIMEOUT_MS,
    )
    return pickMessageId(reply)
  } catch (error) {
    logger.warn('capture: message id lookup failed', { reason: failureReason(error) })
    return null
  }
}

/** 超时就当"没有"（`null`），**绝不把异常抛给调用方** —— 这条路线只该让点击更快或不变。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

interface FinalizeInput {
  readonly temp: string
  readonly name: string
  readonly mime: string
  readonly state: string
  /** 承载页面的上下文：用来反查这条文件属于哪条消息（[ADR-0052]）。 */
  readonly contents: WebContents
  readonly getSettings: () => Settings
}

async function finalize(input: FinalizeInput): Promise<void> {
  const { temp, name, mime, state, contents } = input

  // 在最终落盘这一刻读设置，而不是在注册时读一份快照 ——
  // 否则用户改了"点击时自动打开"要重启才生效。
  const settings = input.getSettings()

  if (state !== 'completed') {
    await unlink(temp).catch(() => undefined)
    logger.warn('capture: download did not complete', { state })
    return
  }

  let hash: string
  let storedName: string
  let bytes: number
  let created: boolean

  /**
   * 归档时间：索引里的 `opened_at`。从 [ADR-0052] 起它**不再决定**文件落在哪（分区改由
   * 消息ID 承担），但它仍是"最后一次被打开"的依据（淘汰排序、界面排序）。
   */
  const openedAt = Date.now()

  /**
   * 先腾地方、再写这一份（[ADR-0048]）。顺序是刻意的：**在落盘之前**淘汰，这一份就绝不会
   * 被它自己的那次淘汰挑中 —— 用户刚点的文件如果因为"上限太小"而当场被删，随后打开必然
   * 失败。代价是占用可能短暂高出上限一份文件的大小，下一次落盘时收回。
   *
   * 临时文件（`.part-*`）是点开头的，不计入 `usage()`，因此这里统计的只是已归档的正文。
   */
  enforceLimit(input.getSettings)

  try {
    ;({ hash, storedName, bytes, created } = await commitFromTemp(temp, name, {
      findStored: findStoredName,
      // 消息ID 只能在算出哈希之后按它反查（[ADR-0052]）；拿不到就由归档层回落到
      // `unknown-message`，绝不阻断落盘。
      resolveMessageId: (contentHash) => askPageForMessageId(contents, contentHash),
      openedAt,
    }))
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
      // 磁盘上的实际路径（相对归档目录：`<账号>/<消息ID>/files/<原名>`，冲突时文件名带哈希
      // 后缀）：打开与"在文件夹中显示"靠它定位（ADR-0031 / ADR-0052）。
      storedName,
      bytes,
      mime,
      openedAt,
      // chatLabel 仍刻意留空：会话标签要有可靠的来源，而现在唯一会读的页面字段是
      // 内容哈希与消息ID（ADR-0047 / ADR-0052）。不要为了填上它而引入新的数据源。
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

  const outcome = await openPath(hash, storedName)
  if (!outcome.ok) {
    markFailure({ kind: 'open-failed', reason: outcome.reason })
    logger.warn('capture: open failed', { hash: hashPrefix(hash), reason: outcome.reason })
    return
  }

  markCaptured()
}

/**
 * 索引里已知的、内容为 `hash` 的那个磁盘路径（相对归档目录，且文件仍在）；没有则返回 `null`。
 *
 * 交给 `commitFromTemp()` 用：同一份内容换个名字发来时，给它在归档里**再挂一个名字**，
 * 而不是再写一份字节（[ADR-0031]）。索引是唯一知道"这份内容叫什么名字、在哪个月份目录里"
 * 的地方 —— 磁盘上的名字与内容无关了，这正是那次改动的代价。
 */
function findStoredName(hash: string): string | null {
  for (const record of archiveStore().byHash(hash)) {
    if (existsSync(archiveFilePath(record.storedName))) return record.storedName
  }

  return null
}

/**
 * 归档里内容为 `hash`、**大小也是 `bytes`**、且文件仍在的那一份（相对路径）；没有则 `null`。
 *
 * 与 {@link findStoredName} 的区别只有一条，但那条是安全关键：**要比大小**。`filehash` 由
 * 对端/服务方提供（[ADR-0047] 的已知限制），只信它一个值就可能把用户**开到错的文件上**；
 * 大小对不上就当成没命中 —— 宁可漏命中（多下载一次），不可错命中（打开无关文件）。
 */
function findArchivedByHash(hash: string, bytes: number): string | null {
  for (const record of archiveStore().byHash(hash)) {
    if (record.bytes !== bytes) continue
    if (existsSync(archiveFilePath(record.storedName))) return record.storedName
  }

  return null
}
