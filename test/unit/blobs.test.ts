/**
 * 归档落盘的单测。
 *
 * 这一层要保证四件事，每一件都对应一个具体的坏结果：
 *
 *   1. **归档目录里永远不存在半成品** —— 靠"先算哈希、再原子改名"的顺序拿到；
 *   2. **文件名是用户认得的原名**（同名冲突时带一小段哈希），否则目录就没法直接看（[ADR-0031]）；
 *   3. **正文只读**，而只读不妨碍删除（否则清理与淘汰都会在只读文件上失败）；
 *   4. **落在 `<年>/<月>/` 里**且那两级目录也是 `0700`（[ADR-0037]）——
 *      年月算错会让"按时间翻文件夹"不可信，目录权限没收紧则会让明文可被同机他人读取。
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

/** 这一轮用例用的归档时间：本地 2026 年 10 月，因此目录固定是 `2026-10`。 */
const AT = new Date(2026, 9, 5, 12).getTime()
/** 之后的两个月：用于跨月的行为（同名不冲突、同内容挂硬链接）。 */
const AT_NEXT = new Date(2026, 10, 3, 12).getTime()
const AT_LATER = new Date(2026, 11, 8, 12).getTime()

/**
 * 这三轮用例没有设置账号标识（`setAccountKey` 只在 `paths.test.ts` 里用），
 * 因此账号那一层是回落值 `unknown-account`（[ADR-0039]）。
 */
const ACCOUNT = 'unknown-account'
/** `stored_name` 的前缀：`<账号>/files/<年-月>`。 */
const DIR = `${ACCOUNT}/files/2026-10`
const DIR_NEXT = `${ACCOUNT}/files/2026-11`
const DIR_LATER = `${ACCOUNT}/files/2026-12`

/** 把一段内容写成归档目录内的临时文件，模拟下载完成后的状态。 */
function staged(content: string): string {
  const path = tempPath()
  writeFileSync(path, content)
  return path
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** 相对路径的最后一段（用例关心"叫什么名字"时用它把年月前缀摘掉）。 */
function leaf(relative: string): string {
  return relative.slice(relative.lastIndexOf('/') + 1)
}

/** 归档目录里的**正文**，相对路径（`2026/10/合同.pdf`；旧布局则是裸文件名）。 */
function bodies(dir: string = archive, prefix = ''): string[] {
  const found: string[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue

    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...bodies(join(dir, entry.name), relative))
    else found.push(relative)
  }

  return found
}

describe('commitFromTemp', () => {
  it('用原文名落盘，而不是哈希名；并落在 <年>/<月>/ 里', async () => {
    const temp = staged('hello waachat')

    const result = await commitFromTemp(temp, '报告 2026Q3.pdf', { openedAt: AT })

    expect(result.created).toBe(true)
    expect(result.hash).toBe(sha256('hello waachat'))
    expect(result.storedName).toBe(`${DIR}/报告 2026Q3.pdf`)
    expect(result.bytes).toBe('hello waachat'.length)
    expect(existsSync(temp)).toBe(false) // rename 而不是 copy：临时名不该留下
    expect(readFileSync(archiveFilePath(result.storedName), 'utf8')).toBe('hello waachat')
  })

  it('账号 / files / 月份三层目录按需创建，且与归档目录同样是 0700', async () => {
    await commitFromTemp(staged(`perm-${String(Date.now())}`), 'perm.pdf', { openedAt: AT })

    // 三层都是我们建的：mkdir 的 mode 只对新建的目录生效，因此这条断言守的是
    // "里面是解密后的明文"那道权限线在子目录上也没漏（[ADR-0039]）。
    expect(statSync(join(archive, ACCOUNT)).mode & 0o777).toBe(0o700)
    expect(statSync(join(archive, ACCOUNT, 'files')).mode & 0o777).toBe(0o700)
    expect(statSync(join(archive, ACCOUNT, 'files', '2026-10')).mode & 0o777).toBe(0o700)
  })

  it('同名同内容命中去重，并丢弃临时文件', async () => {
    const content = `dup-${String(Date.now())}`

    const first = await commitFromTemp(staged(content), '合同.pdf', { openedAt: AT })
    const second = await commitFromTemp(staged(content), '合同.pdf', { openedAt: AT })

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.storedName).toBe(first.storedName)

    // 关键断言：去重命中的临时文件必须被清掉，否则重复打开同一个文件会不断留下垃圾。
    expect(readdirSync(archive).filter((name) => name.startsWith('.part-'))).toHaveLength(0)
  })

  it('同一个年月目录里同名不同内容时给后者加一段哈希后缀（绝不覆盖）', async () => {
    const first = await commitFromTemp(staged(`first-${String(Date.now())}`), '合同.pdf', {
      openedAt: AT,
    })
    const second = await commitFromTemp(staged(`second-${String(Date.now())}`), '合同.pdf', {
      openedAt: AT,
    })

    expect(second.storedName).not.toBe(first.storedName)
    expect(leaf(second.storedName).startsWith('合同 (')).toBe(true)
    expect(leaf(second.storedName).endsWith(').pdf')).toBe(true)

    // 两份内容都还在，谁也没被覆盖 —— 覆盖一份用户可能只有一份的文件是最不可接受的失败。
    expect(readFileSync(archiveFilePath(first.storedName), 'utf8')).toContain('first-')
    expect(readFileSync(archiveFilePath(second.storedName), 'utf8')).toContain('second-')
  })

  it('跨月的同名文件互不冲突，各自用原名（分区带来的好处）', async () => {
    // 名字带上时间戳：这条断言关心的是**两个月之间**没有冲突，不该被别的用例在同一
    // 个月里留下的同名文件影响。
    const name = `跨月合同-${String(Date.now())}.pdf`

    const first = await commitFromTemp(staged(`oct-${String(Date.now())}`), name, { openedAt: AT })
    const second = await commitFromTemp(staged(`nov-${String(Date.now())}`), name, {
      openedAt: AT_NEXT,
    })

    expect(first.storedName).toBe(`${DIR}/${name}`)
    expect(second.storedName).toBe(`${DIR_NEXT}/${name}`)
    expect(readFileSync(archiveFilePath(second.storedName), 'utf8')).toContain('nov-')
  })

  it('同一份内容换个名字时只多一个名字，不多占字节', async () => {
    const content = `alias-${String(Date.now())}`
    const first = await commitFromTemp(staged(content), '报告.pdf', { openedAt: AT })

    const second = await commitFromTemp(staged(content), '报价单.pdf', {
      openedAt: AT,
      findStored: (hash) => (hash === first.hash ? first.storedName : null),
    })

    expect(second.created).toBe(false)
    expect(second.storedName).toBe(`${DIR}/报价单.pdf`)
    // 硬链接：两个名字，同一个 inode。
    expect(statSync(archiveFilePath(second.storedName)).ino).toBe(
      statSync(archiveFilePath(first.storedName)).ino,
    )
  })

  it('同一份内容跨月出现时，在另一个年月目录里挂硬链接（占用不变）', async () => {
    const content = `cross-month-${String(Date.now())}`
    const name = `跨月报告-${String(Date.now())}.pdf`

    const first = await commitFromTemp(staged(content), name, { openedAt: AT })
    const before = usage()

    const second = await commitFromTemp(staged(content), name, {
      openedAt: AT_LATER,
      findStored: (hash) => (hash === first.hash ? first.storedName : null),
    })

    expect(second.created).toBe(false)
    expect(second.storedName).toBe(`${DIR_LATER}/${name}`)
    // 两个不同的目录、同一个 inode：目录按时间分区，但"同一份内容只存一份"这条不变量不变。
    expect(statSync(archiveFilePath(second.storedName)).ino).toBe(
      statSync(archiveFilePath(first.storedName)).ino,
    )
    expect(usage()).toEqual(before)
  })

  it('索引给的线索指向一个已经不存在的文件时，老老实实写一份新的', async () => {
    const content = `stale-${String(Date.now())}`

    const result = await commitFromTemp(staged(content), 'x.pdf', {
      openedAt: AT,
      findStored: () => '早就没了的名字.pdf',
    })

    expect(result.created).toBe(true)
    expect(readFileSync(archiveFilePath(result.storedName), 'utf8')).toBe(content)
  })

  it('落盘即只读，而只读不妨碍删除', async () => {
    const result = await commitFromTemp(staged(`read-only-${String(Date.now())}`), 'readonly.pdf', {
      openedAt: AT,
    })
    const path = archiveFilePath(result.storedName)

    expect(statSync(path).mode & 0o777).toBe(ARCHIVE_FILE_MODE)

    // 只读挡的是"就地改内容"，不是删除：删除只依赖**目录**的写权限。
    // 这一条如果坏了，`wipeArchive()` 与淘汰都会在只读文件上失败。
    expect(() => rmSync(path)).not.toThrow()
    expect(existsSync(path)).toBe(false)
  })
})

describe('archiveFilePath', () => {
  it('把相对路径接到归档目录后面（账号 / files / 月份都在 Path 里）', async () => {
    const result = await commitFromTemp(staged(`path-${String(Date.now())}`), 'p.pdf', {
      openedAt: AT,
    })

    expect(archiveFilePath(result.storedName)).toBe(
      join(archive, ACCOUNT, 'files', '2026-10', 'p.pdf'),
    )
  })

  it('索引被改坏也走不出归档目录（`..` 被剥掉，只落到一个不存在的名字上）', () => {
    const escaped = archiveFilePath('../../../../etc/passwd')

    expect(escaped.startsWith(`${archive}/`)).toBe(true)
    expect(existsSync(escaped)).toBe(false)
  })

  it('什么都剩不下时不会退化成归档目录本身（否则"打开这个文件"会变成"打开整个目录"）', () => {
    expect(archiveFilePath('..')).not.toBe(archive)
    expect(existsSync(archiveFilePath('..'))).toBe(false)
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

  it('年月子目录里的正文照样计入（统计要递归）', async () => {
    const content = `counted-${String(Date.now())}`
    const before = usage()

    const result = await commitFromTemp(staged(content), 'counted.pdf', { openedAt: AT })
    const after = usage()

    expect(statSync(archiveFilePath(result.storedName)).size).toBe(content.length)
    expect(after.files).toBe(before.files + 1)
    expect(after.bytes).toBe(before.bytes + content.length)
  })

  it('同一份内容的多个名字只算一份（按 inode 去重，跨年月目录也成立）', async () => {
    const content = `usage-alias-${String(Date.now())}`
    const first = await commitFromTemp(staged(content), 'a.pdf', { openedAt: AT })
    const before = usage()

    await commitFromTemp(staged(content), 'b.pdf', {
      openedAt: AT,
      findStored: (hash) => (hash === first.hash ? first.storedName : null),
    })

    // 多了一个名字，但占用不变 —— 这正是硬链接的意义，也是"按 inode 去重"存在的理由。
    expect(bodies()).toContain(`${DIR}/b.pdf`)
    expect(usage()).toEqual(before)
  })
})
