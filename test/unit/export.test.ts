/**
 * 批量导出的单测（[ADR-0050]）。
 *
 * 导出是唯一一个**往用户的目录里写东西**的动作，因此每一条断言都对应一个具体的坏结果：
 * 名字用错（把归档的内部名带出去）、覆盖别人的同名文件、副本是只读的（用户改不了）、
 * 正文不在时静默少一个文件、目标落在归档里面。
 *
 * 不需要 sqlite：`exportRecords()` 收的是 `ArchiveRecord` 数据，索引不参与。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { ARCHIVE_FILE_MODE, archiveFilePath, setReadOnly } from '../../src/main/archive/blobs'
import { EXPORT_MAX_ITEMS, exportRecords, isInsideArchive } from '../../src/main/archive/export'
import { setArchiveDir } from '../../src/main/paths'
import type { ArchiveRecord } from '../../src/shared/types'

let root: string
let archive: string
let target: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'waachat-export-'))
  archive = join(root, 'media')
  target = join(root, 'out')
})

afterAll(() => {
  setArchiveDir('')
  rmSync(root, { recursive: true, force: true })
})

/** 每个用例从"空归档 + 空目标目录"开始。 */
afterEach(() => {
  rmSync(archive, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
  setArchiveDir(archive)
  mkdirSync(archive, { recursive: true, mode: 0o700 })
  mkdirSync(target, { recursive: true })
})

/** 在归档里放一份**只读**正文（与真实落盘后的状态一致：[ADR-0031]）。 */
function putSource(storedName: string, content: string): void {
  const path = archiveFilePath(storedName)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  setReadOnly(path)
}

function record(name: string, storedName: string, hash = 'a'.repeat(64)): ArchiveRecord {
  return {
    id: 1,
    hash,
    name,
    storedName,
    bytes: 0,
    mime: 'application/pdf',
    openedAt: 1_700_000_000_000,
  }
}

describe('isInsideArchive', () => {
  it('归档目录本身、以及它下面的任何路径都算"在里"', () => {
    expect(isInsideArchive('/data/media', '/data/media')).toBe(true)
    expect(isInsideArchive('/data/media/files/2026-10', '/data/media')).toBe(true)
    expect(isInsideArchive('/data/media/', '/data/media')).toBe(true)
  })

  it('只是前缀相同的兄弟目录不算', () => {
    // `/data/media2` 以 `/data/media` 开头 —— 漏掉结尾的斜杠就会把它误判成子目录。
    expect(isInsideArchive('/data/media2', '/data/media')).toBe(false)
    expect(isInsideArchive('/data/medi', '/data/media')).toBe(false)
  })

  it('上级目录不算（导出到 ~/Documents 完全正常，归档就在它下面）', () => {
    expect(isInsideArchive('/data', '/data/media')).toBe(false)
    expect(isInsideArchive('/', '/data/media')).toBe(false)
  })

  it('空串不当成"在里"', () => {
    expect(isInsideArchive('', '/data/media')).toBe(false)
    expect(isInsideArchive('/data/media', '')).toBe(false)
  })
})

describe('exportRecords', () => {
  it('复制到目标目录，名字取记录里的原名（不是磁盘上那个可能带哈希后缀的名字）', async () => {
    // 磁盘名带哈希后缀（同月同名的冲突形态），而记录里的原文名是干净的。
    putSource('uuid/files/2026-10/报告 (a1b2c3d4).pdf', 'PDF-BYTES')

    const result = await exportRecords(
      [record('报告.pdf', 'uuid/files/2026-10/报告 (a1b2c3d4).pdf')],
      target,
    )

    expect(result).toEqual({ exported: 1, failed: [] })
    expect(readFileSync(join(target, '报告.pdf'), 'utf8')).toBe('PDF-BYTES')
  })

  it('导出的是**可写**副本，归档里那份仍然是只读的', async () => {
    putSource('uuid/files/2026-10/合同.pdf', 'DATA')

    await exportRecords([record('合同.pdf', 'uuid/files/2026-10/合同.pdf')], target)

    expect(statSync(join(target, '合同.pdf')).mode & 0o777).toBe(0o644)
    // 归档那一份一个字节都不动，连模式也不变（ADR-0031 的只读纪律）。
    expect(statSync(archiveFilePath('uuid/files/2026-10/合同.pdf')).mode & 0o777).toBe(
      ARCHIVE_FILE_MODE,
    )
  })

  it('目标里已有同名文件时给序号，绝不覆盖', async () => {
    putSource('uuid/files/2026-10/报告.pdf', 'OURS')
    // 用户自己的同名文件：它必须原封不动。
    writeFileSync(join(target, '报告.pdf'), '别人的东西')

    const result = await exportRecords([record('报告.pdf', 'uuid/files/2026-10/报告.pdf')], target)

    expect(result.exported).toBe(1)
    expect(readFileSync(join(target, '报告.pdf'), 'utf8')).toBe('别人的东西')
    expect(readFileSync(join(target, '报告 (1).pdf'), 'utf8')).toBe('OURS')
  })

  it('同一批里的两条同名记录不会互相覆盖', async () => {
    putSource('uuid/files/2026-10/甲.pdf', 'FIRST')
    putSource('uuid/files/2026-11/甲.pdf', 'SECOND')

    const result = await exportRecords(
      [
        record('甲.pdf', 'uuid/files/2026-10/甲.pdf', 'a'.repeat(64)),
        record('甲.pdf', 'uuid/files/2026-11/甲.pdf', 'b'.repeat(64)),
      ],
      target,
    )

    expect(result).toEqual({ exported: 2, failed: [] })
    expect(readFileSync(join(target, '甲.pdf'), 'utf8')).toBe('FIRST')
    expect(readFileSync(join(target, '甲 (1).pdf'), 'utf8')).toBe('SECOND')
  })

  it('正文不在时逐条报 missing，其余照常导出', async () => {
    putSource('uuid/files/2026-10/在.pdf', 'HERE')

    const result = await exportRecords(
      [
        record('没了.pdf', 'uuid/files/2026-10/没了.pdf'),
        record('在.pdf', 'uuid/files/2026-10/在.pdf'),
      ],
      target,
    )

    // 静默跳过会让"1 个成功"变成谎话 —— 用户是按自己选了两条来对账的。
    expect(result.exported).toBe(1)
    expect(result.failed).toEqual([{ name: '没了.pdf', reason: 'missing' }])
    expect(existsSync(join(target, '没了.pdf'))).toBe(false)
  })

  it('正文是目录（不是普通文件）时算失败，不会把它复制过去', async () => {
    putSource('uuid/files/2026-10/正常.pdf', 'OK')
    mkdirSync(archiveFilePath('uuid/files/2026-10/怪.pdf'), { recursive: true })

    const result = await exportRecords(
      [
        record('怪.pdf', 'uuid/files/2026-10/怪.pdf'),
        record('正常.pdf', 'uuid/files/2026-10/正常.pdf'),
      ],
      target,
    )

    expect(result.exported).toBe(1)
    expect(result.failed).toEqual([{ name: '怪.pdf', reason: 'write-failed' }])
  })

  it('目标目录不存在时直接抛错（整次调用被拒绝，不是逐条失败）', async () => {
    putSource('uuid/files/2026-10/合同.pdf', 'DATA')

    await expect(
      exportRecords(
        [record('合同.pdf', 'uuid/files/2026-10/合同.pdf')],
        join(root, '没有这个目录'),
      ),
    ).rejects.toThrow()
  })

  it('单次上限是个防御性数字，不是对正常使用的限制', () => {
    // 列表窗口一页 100 条，因此这个数字应当明显大于一页。
    expect(EXPORT_MAX_ITEMS).toBeGreaterThan(100)
  })
})
