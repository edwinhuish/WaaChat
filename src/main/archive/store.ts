/**
 * 归档索引。
 *
 * 归档的价值一半在"打开快"，另一半在"找得到"——本模块负责后者。
 *
 * 它**不知道文件从哪来**（依赖方向：capture → archive，反过来不允许，
 * 见 ai/CONVENTIONS.md 第 2 节）。
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import Database from 'better-sqlite3'

import type { ArchiveQuery, ArchiveRecord, ArchiveStats } from '../../shared/types'
import { logger, redactPath } from '../logger'
import { indexDbPath, setArchiveDir } from '../paths'
import { ensureArchiveDir, usage } from './blobs'
import schema from './schema.sql?raw'

/** 目录权限收紧：索引里含"谁在何时打开过什么文件"这类元数据。 */
const DIR_MODE = 0o700

interface FileRow {
  id: number
  hash: string
  name: string
  bytes: number
  mime: string
  opened_at: number
  chat_label: string | null
}

function toRecord(row: FileRow): ArchiveRecord {
  return {
    id: row.id,
    hash: row.hash,
    name: row.name,
    bytes: row.bytes,
    mime: row.mime,
    openedAt: row.opened_at,
    ...(row.chat_label === null ? {} : { chatLabel: row.chat_label }),
  }
}

export class ArchiveStore {
  readonly #db: Database.Database

  constructor(path: string = indexDbPath()) {
    mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
    this.#db = new Database(path)

    // WAL 让读写不互相阻塞：界面在搜索时，接管逻辑仍在写入。
    this.#db.pragma('journal_mode = WAL')
    this.#db.pragma('synchronous = NORMAL')
    this.#db.exec(schema)
  }

  /**
   * 记录一次归档。
   *
   * 同一个 (hash, name) 重复出现时**更新打开时间**而非新增行 ——
   * 否则用户每打开一次同一个文件，搜索里就多一条重复条目。
   */
  record(record: Omit<ArchiveRecord, 'id'>): ArchiveRecord {
    const existing = this.#db
      .prepare('SELECT id FROM files WHERE hash = ? AND name = ?')
      .get(record.hash, record.name) as { id: number } | undefined

    if (existing !== undefined) {
      this.#db
        .prepare('UPDATE files SET opened_at = ? WHERE id = ?')
        .run(record.openedAt, existing.id)
      const row = this.#db.prepare('SELECT * FROM files WHERE id = ?').get(existing.id) as FileRow
      return toRecord(row)
    }

    const info = this.#db
      .prepare(
        `INSERT INTO files (hash, name, bytes, mime, opened_at, chat_label)
         VALUES (@hash, @name, @bytes, @mime, @openedAt, @chatLabel)`,
      )
      .run({ ...record, chatLabel: record.chatLabel ?? null })

    const row = this.#db
      .prepare('SELECT * FROM files WHERE id = ?')
      .get(info.lastInsertRowid) as FileRow

    return toRecord(row)
  }

  list(query: ArchiveQuery = {}): ArchiveRecord[] {
    const limit = query.limit ?? 100
    const offset = query.offset ?? 0
    const text = query.text?.trim() ?? ''

    if (text.length === 0) {
      const rows = this.#db
        .prepare('SELECT * FROM files ORDER BY opened_at DESC LIMIT ? OFFSET ?')
        .all(limit, offset) as FileRow[]
      return rows.map(toRecord)
    }

    // trigram 分词器要求查询串至少 3 个字符。更短的查询回退到 LIKE ——
    // 不支持短查询会让"搜两个字的文件名"直接返回空，那看起来像坏了。
    const rows =
      text.length >= 3
        ? (this.#db
            .prepare(
              `SELECT f.* FROM files_fts
                 JOIN files f ON f.id = files_fts.rowid
                WHERE files_fts MATCH ?
                ORDER BY f.opened_at DESC LIMIT ? OFFSET ?`,
            )
            .all(escapeFtsQuery(text), limit, offset) as FileRow[])
        : (this.#db
            .prepare(
              `SELECT * FROM files WHERE name LIKE ? ESCAPE '\\'
                ORDER BY opened_at DESC LIMIT ? OFFSET ?`,
            )
            .all(`%${escapeLike(text)}%`, limit, offset) as FileRow[])

    return rows.map(toRecord)
  }

  byId(id: number): ArchiveRecord | null {
    const row = this.#db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined
    return row === undefined ? null : toRecord(row)
  }

  /** 内容哈希对应的所有记录。用于淘汰与去重后的引用检查。 */
  byHash(hash: string): ArchiveRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM files WHERE hash = ? ORDER BY opened_at DESC')
      .all(hash) as FileRow[]
    return rows.map(toRecord)
  }

  /**
   * 删除指定内容哈希的所有记录。
   *
   * **必须**与 `blobs.evictToFit()` 的返回值配合使用：文件被删而记录还在，
   * 会产生"搜得到但打不开"的悬空记录。这个方法的调用者负有同步义务。
   */
  deleteByHashes(hashes: readonly string[]): number {
    if (hashes.length === 0) return 0

    const statement = this.#db.prepare('DELETE FROM files WHERE hash = ?')
    const run = this.#db.transaction((items: readonly string[]) => {
      let affected = 0
      for (const hash of items) affected += statement.run(hash).changes
      return affected
    })

    return run(hashes)
  }

  stats(): ArchiveStats {
    const { bytes, files } = usage()
    return { fileCount: files, totalBytes: bytes, cacheBytes: 0 }
  }

  close(): void {
    try {
      this.#db.close()
    } catch (error) {
      logger.warn('archive: close failed', { reason: (error as Error).name })
    }
  }
}

let instance: ArchiveStore | null = null

/** 进程内单例。避免多处各开一个连接导致 WAL 争用。 */
export function archiveStore(): ArchiveStore {
  instance ??= new ArchiveStore()
  return instance
}

/**
 * 关闭连接（若已打开）。
 *
 * 在退出流程里调用。WAL 模式下不关闭连接会留下 `-wal` / `-shm` 文件，
 * 下次打开时它们会被自动恢复 —— 通常无害，但会让"归档目录里多了两个陌生文件"
 * 变成用户可见的困惑。**不要**在这里顺手创建连接：退出时不该新建数据库文件。
 */
export function closeArchiveStore(): void {
  instance?.close()
  instance = null
}

/**
 * 应用"文件保存位置"这个设置。返回最终生效的归档目录。
 *
 * 索引数据库在归档目录内部（[ADR-0018]），所以换目录必须**断开旧连接** ——
 * 不断开的话后续写入会继续落到旧的 `.index.sqlite` 里，症状是"文件在新目录、
 * 索引在旧目录"，用户在归档界面里搜到的东西都打不开。断开是幂等的：
 * 下一次 `archiveStore()` 会按新路径重新打开。
 *
 * 顺序不能反：先切目录，再建目录（`ensureArchiveDir` 读的是当前生效的目录），
 * 最后才断开连接。
 */
export function applyArchiveDir(raw: string): string {
  const dir = setArchiveDir(raw)

  ensureArchiveDir()
  closeArchiveStore()

  logger.info('archive: location applied', { dir: redactPath(dir) })
  return dir
}

/** FTS5 MATCH 语法里有特殊含义的字符需要转义，否则查询会抛错而不是返回空。 */
function escapeFtsQuery(text: string): string {
  return `"${text.replace(/"/g, '""')}"`
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (match) => `\\${match}`)
}
