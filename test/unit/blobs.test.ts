/**
 * 归档落盘的单测。
 *
 * 这一层要保证三件事，每一件都对应一个具体的坏结果：
 *
 *   1. **归档目录里永远不存在半成品** —— 靠"先算哈希、再原子改名"的顺序拿到；
 *   2. **文件名是用户认得的原名**（同名冲突时带一小段哈希），否则目录就没法直接看（[ADR-0031]）；
 *   3. **正文只读**，而只读不妨碍删除（否则清理与淘汰都会在只读文件上失败）。
 *
 * 因此测试跑在真实文件系统上（隔离在临时的归档目录里），而不是 mock `node:fs` —— mock 掉
 * fs 之后，被测的恰好就只剩"我有没有按顺序调用它们"，而顺序正是最容易看出来的东西。
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ARCHIVE_FILE_MODE,
  archiveFilePath,
  commitFromTemp,
  ensureArchiveDir,
  sweepTempFiles,
  tempPath,
  usage,
} from '../../src/main/archive/blobs'
import { setArchiveDir } from '../../src/main/paths'

let root: string
/** 这一轮测试使用的归档目录。 */
let archive: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'waachat-blobs-'))

  // 归档位置由设置注入（ADR-0018），不再从 XDG 变量推导 —— 必须显式挡开，
  // 否则这些用例会写进开发者本机真实的 `~/Documents/WaaChat_files`。
  archive = join(root, 'archive')
  setArchiveDir(archive)
  ensureArchiveDir()
})

afterAll(() => {
  // 复位模块级状态：同一个进程里的其它用例不该继承这个临时目录。
  setArchiveDir('')

  rmSync(root, { recursive: true, force: true })
})

/** 把一段内容写成归档目录内的临时文件，模拟下载完成后的状态。 */
function staged(content: string): string {
  const path = tempPath()
  writeFileSync(path, content)
  return path
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** 归档目录里的**正文**（非点开头的东西）。 */
function bodies(): string[] {
  return readdirSync(archive).filter((name) => !name.startsWith('.'))
}

describe('commitFromTemp', () => {
  it('用原文名落盘，而不是哈希名', async () => {
    const temp = staged('hello waachat')

    const result = await commitFromTemp(temp, '报告 2026Q3.pdf')

    expect(result.created).toBe(true)
    expect(result.hash).toBe(sha256('hello waachat'))
    expect(result.storedName).toBe('报告 2026Q3.pdf')
    expect(result.bytes).toBe('hello waachat'.length)
    expect(existsSync(temp)).toBe(false) // rename 而不是 copy：临时名不该留下
    expect(readFileSync(archiveFilePath(result.storedName), 'utf8')).toBe('hello waachat')
  })

  it('同名同内容命中去重，并丢弃临时文件', async () => {
    const content = `dup-${String(Date.now())}`

    const first = await commitFromTemp(staged(content), '合同.pdf')
    const second = await commitFromTemp(staged(content), '合同.pdf')

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.storedName).toBe(first.storedName)

    // 关键断言：去重命中的临时文件必须被清掉，否则重复打开同一个文件会不断留下垃圾。
    expect(readdirSync(archive).filter((name) => name.startsWith('.part-'))).toHaveLength(0)
  })

  it('同名不同内容时给后者加一段哈希后缀（绝不覆盖）', async () => {
    const first = await commitFromTemp(staged(`first-${String(Date.now())}`), '合同.pdf')
    const second = await commitFromTemp(staged(`second-${String(Date.now())}`), '合同.pdf')

    expect(second.storedName).not.toBe(first.storedName)
    expect(second.storedName.startsWith('合同 (')).toBe(true)
    expect(second.storedName.endsWith(').pdf')).toBe(true)

    // 两份内容都还在，谁也没被覆盖 —— 覆盖一份用户可能只有一份的文件是最不可接受的失败。
    expect(readFileSync(archiveFilePath(first.storedName), 'utf8')).toContain('first-')
    expect(readFileSync(archiveFilePath(second.storedName), 'utf8')).toContain('second-')
  })

  it('同一份内容换个名字时只多一个名字，不多占字节', async () => {
    const content = `alias-${String(Date.now())}`
    const first = await commitFromTemp(staged(content), '报告.pdf')

    const second = await commitFromTemp(staged(content), '报价单.pdf', {
      findStored: (hash) => (hash === first.hash ? first.storedName : null),
    })

    expect(second.created).toBe(false)
    expect(second.storedName).toBe('报价单.pdf')
    // 硬链接：两个名字，同一个 inode。
    expect(statSync(archiveFilePath(second.storedName)).ino).toBe(
      statSync(archiveFilePath(first.storedName)).ino,
    )
  })

  it('索引给的线索指向一个已经不存在的文件时，老老实实写一份新的', async () => {
    const content = `stale-${String(Date.now())}`

    const result = await commitFromTemp(staged(content), 'x.pdf', {
      findStored: () => '早就没了的名字.pdf',
    })

    expect(result.created).toBe(true)
    expect(readFileSync(archiveFilePath(result.storedName), 'utf8')).toBe(content)
  })

  it('落盘即只读，而只读不妨碍删除', async () => {
    const result = await commitFromTemp(staged(`read-only-${String(Date.now())}`), 'readonly.pdf')
    const path = archiveFilePath(result.storedName)

    expect(statSync(path).mode & 0o777).toBe(ARCHIVE_FILE_MODE)

    // 只读挡的是"就地改内容"，不是删除：删除只依赖**目录**的写权限。
    // 这一条如果坏了，`wipeArchive()` 与淘汰都会在只读文件上失败。
    expect(() => rmSync(path)).not.toThrow()
    expect(existsSync(path)).toBe(false)
  })
})

describe('sweepTempFiles', () => {
  it('清掉进程被 kill 时留下的半成品', () => {
    writeFileSync(join(archive, '.part-leftover'), 'half written')

    const removed = sweepTempFiles()

    expect(removed).toBeGreaterThanOrEqual(1)
    expect(existsSync(join(archive, '.part-leftover'))).toBe(false)
  })
})

describe('usage', () => {
  it('跳过内部条目（旧影子目录与索引）', () => {
    // 用"前后快照相等"来断言，而不是拿条目数去对：目录里的东西由别的用例攒出来，
    // 数条目数等于把用例的执行顺序写进断言里。
    const before = usage()

    mkdirSync(join(archive, '.open', 'legacy'), { recursive: true })
    writeFileSync(join(archive, '.open', 'legacy', 'file.pdf'), 'x')
    writeFileSync(join(archive, '.index.sqlite'), 'not a real database')

    expect(usage()).toEqual(before)
  })

  it('同一份内容的多个名字只算一份（按 inode 去重）', async () => {
    const content = `usage-alias-${String(Date.now())}`
    const first = await commitFromTemp(staged(content), 'a.pdf')
    const before = usage()

    await commitFromTemp(staged(content), 'b.pdf', {
      findStored: (hash) => (hash === first.hash ? first.storedName : null),
    })

    // 多了一个名字，但占用不变 —— 这正是硬链接的意义，也是"按 inode 去重"存在的理由。
    expect(bodies()).toContain('b.pdf')
    expect(usage()).toEqual(before)
  })
})
