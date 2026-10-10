/**
 * 归档落盘的单测。
 *
 * 这一层要保证四件事，每一件都对应一个具体的坏结果：
 *
 *   1. **归档目录里永远不存在半成品** —— 靠"先算哈希、再原子改名"的顺序拿到；
 *   2. **文件名是用户认得的原名**（同名冲突时带一小段哈希），否则目录就没法直接看（[ADR-0031]）；
 *   3. **正文只读**，而只读不妨碍删除（否则清理与淘汰都会在只读文件上失败）；
 *   4. **落在 `<账号>/<消息ID>/files/` 里**且那几级目录也是 `0700`（[ADR-0052]）——
 *      消息ID 拼错会让文件落进别人的消息目录，目录权限没收紧则会让明文可被同机他人读取。
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
  evictToFit,
  sweepTempFiles,
  tempPath,
  usage,
  type EvictionCandidate,
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

/** 归档时间（Unix 毫秒）—— 从 [ADR-0052] 起它只进索引，不再决定落盘位置。 */
const AT = new Date(2026, 9, 5, 12).getTime()

/**
 * 这些用例没有设置账号标识（`setAccountKey` 只在 `paths.test.ts` 里用），
 * 因此账号那一层是回落值 `unknown-account`（[ADR-0039]）。
 */
const ACCOUNT = 'unknown-account'
/** 两条不同的消息：用来验证"同名不冲突 / 同内容挂硬链接"两条行为。
 *  长度都在 8 以上，满足 `isMessageSegment()`（迁移的容器判据）。 */
const MESSAGE = '3EB0A1B2C3D4E5F6A7B8'
const MESSAGE_OTHER = '3EB0FFFFFFFFFFFFFFFF'
/** `stored_name` 的前缀：`<账号>/<消息ID>/files`（[ADR-0052]）。 */
const DIR = `${ACCOUNT}/${MESSAGE}/files`
const DIR_OTHER = `${ACCOUNT}/${MESSAGE_OTHER}/files`
/** 拿不到消息ID时的回落目录（与账号回落对称）。 */
const DIR_FALLBACK = `${ACCOUNT}/unknown-message/files`

/** 把一段内容写成归档目录内的临时文件，模拟下载完成后的状态。 */
function staged(content: string): string {
  const path = tempPath()
  writeFileSync(path, content)
  return path
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** 相对路径的最后一段（用例关心"叫什么名字"时用它把容器前缀摘掉）。 */
function leaf(relative: string): string {
  return relative.slice(relative.lastIndexOf('/') + 1)
}

/** 归档目录里的**正文**，相对路径（`<账号>/<消息ID>/files/合同.pdf`）。 */
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
  it('用原文名落盘，而不是哈希名；并落在 <账号>/<消息ID>/files/ 里', async () => {
    const temp = staged('hello waachat')

    const result = await commitFromTemp(temp, '报告 2026Q3.pdf', {
      messageId: MESSAGE,
      openedAt: AT,
    })

    expect(result.created).toBe(true)
    expect(result.hash).toBe(sha256('hello waachat'))
    expect(result.storedName).toBe(`${DIR}/报告 2026Q3.pdf`)
    expect(result.bytes).toBe('hello waachat'.length)
    expect(existsSync(temp)).toBe(false) // rename 而不是 copy：临时名不该留下
    expect(readFileSync(archiveFilePath(result.storedName), 'utf8')).toBe('hello waachat')
  })

  it('账号 / 消息ID / files 三级目录按需创建，且与归档目录同样是 0700', async () => {
    await commitFromTemp(staged(`perm-${String(Date.now())}`), 'perm.pdf', {
      messageId: MESSAGE,
      openedAt: AT,
    })

    // 三级都是我们建的：mkdir 的 mode 只对新建的目录生效，因此这条断言守的是
    // "里面是解密后的明文"那道权限线在子目录上也没漏（[ADR-0052]）。
    expect(statSync(join(archive, ACCOUNT)).mode & 0o777).toBe(0o700)
    expect(statSync(join(archive, ACCOUNT, MESSAGE)).mode & 0o777).toBe(0o700)
    expect(statSync(join(archive, ACCOUNT, MESSAGE, 'files')).mode & 0o777).toBe(0o700)
  })

  it('拿不到消息ID时落进 unknown-message（与账号回落对称）', async () => {
    const name = `无消息-${String(Date.now())}.pdf`

    const result = await commitFromTemp(staged(`no-msg-${String(Date.now())}`), name, {
      openedAt: AT,
    })

    expect(result.storedName).toBe(`${DIR_FALLBACK}/${name}`)
    expect(existsSync(archiveFilePath(result.storedName))).toBe(true)
  })

  it('消息ID 需要净化时（含路径分隔符）先净化再当目录名', async () => {
    const name = `净化-${String(Date.now())}.pdf`

    const result = await commitFromTemp(staged(`sanitize-${String(Date.now())}`), name, {
      messageId: '3EB0/A1B2',
      openedAt: AT,
    })

    expect(result.storedName).toBe(`${ACCOUNT}/3EB0A1B2/files/${name}`)
  })

  it('同名同内容命中去重，并丢弃临时文件', async () => {
    const content = `dup-${String(Date.now())}`

    const first = await commitFromTemp(staged(content), '合同.pdf', {
      messageId: MESSAGE,
      openedAt: AT,
    })
    const second = await commitFromTemp(staged(content), '合同.pdf', {
      messageId: MESSAGE,
      openedAt: AT,
    })

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.storedName).toBe(first.storedName)

    // 关键断言：去重命中的临时文件必须被清掉，否则重复打开同一个文件会不断留下垃圾。
    expect(readdirSync(archive).filter((name) => name.startsWith('.part-'))).toHaveLength(0)
  })

  it('同一条消息的目录里同名不同内容时给后者加一段哈希后缀（绝不覆盖）', async () => {
    const first = await commitFromTemp(staged(`first-${String(Date.now())}`), '合同.pdf', {
      messageId: MESSAGE,
      openedAt: AT,
    })
    const second = await commitFromTemp(staged(`second-${String(Date.now())}`), '合同.pdf', {
      messageId: MESSAGE,
      openedAt: AT,
    })

    expect(second.storedName).not.toBe(first.storedName)
    expect(leaf(second.storedName).startsWith('合同 (')).toBe(true)
    expect(leaf(second.storedName).endsWith(').pdf')).toBe(true)

    // 两份内容都还在，谁也没被覆盖 —— 覆盖一份用户可能只有一份的文件是最不可接受的失败。
    expect(readFileSync(archiveFilePath(first.storedName), 'utf8')).toContain('first-')
    expect(readFileSync(archiveFilePath(second.storedName), 'utf8')).toContain('second-')
  })

  it('不同消息里的同名文件互不冲突，各自用原名（分区带来的好处）', async () => {
    // 名字带上时间戳：这条断言关心的是**两条消息之间**没有冲突，不该被别的用例留在同一条
    // 消息目录里的同名文件影响。
    const name = `跨消息合同-${String(Date.now())}.pdf`

    const first = await commitFromTemp(staged(`one-${String(Date.now())}`), name, {
      messageId: MESSAGE,
      openedAt: AT,
    })
    const second = await commitFromTemp(staged(`two-${String(Date.now())}`), name, {
      messageId: MESSAGE_OTHER,
      openedAt: AT,
    })

    expect(first.storedName).toBe(`${DIR}/${name}`)
    expect(second.storedName).toBe(`${DIR_OTHER}/${name}`)
    expect(readFileSync(archiveFilePath(second.storedName), 'utf8')).toContain('two-')
  })

  it('同一份内容换个名字时只多一个名字，不多占字节', async () => {
    const content = `alias-${String(Date.now())}`
    const first = await commitFromTemp(staged(content), '报告.pdf', {
      messageId: MESSAGE,
      openedAt: AT,
    })

    const second = await commitFromTemp(staged(content), '报价单.pdf', {
      messageId: MESSAGE,
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

  it('同一份内容出现在另一条消息里时，在新消息目录里挂硬链接（占用不变）', async () => {
    const content = `cross-message-${String(Date.now())}`
    const name = `跨消息报告-${String(Date.now())}.pdf`

    const first = await commitFromTemp(staged(content), name, {
      messageId: MESSAGE,
      openedAt: AT,
    })
    const before = usage()

    const second = await commitFromTemp(staged(content), name, {
      messageId: MESSAGE_OTHER,
      openedAt: AT,
      findStored: (hash) => (hash === first.hash ? first.storedName : null),
    })

    expect(second.created).toBe(false)
    expect(second.storedName).toBe(`${DIR_OTHER}/${name}`)
    // 两条消息各有一个名字、同一个 inode：目录按消息分区，但"同一份内容只存一份"这条
    // 不变量不变（[ADR-0052]）。
    expect(statSync(archiveFilePath(second.storedName)).ino).toBe(
      statSync(archiveFilePath(first.storedName)).ino,
    )
    expect(usage()).toEqual(before)
  })

  it('索引给的线索指向一个已经不存在的文件时，老老实实写一份新的', async () => {
    const content = `stale-${String(Date.now())}`

    const result = await commitFromTemp(staged(content), 'x.pdf', {
      messageId: MESSAGE,
      openedAt: AT,
      findStored: () => '早就没了的名字.pdf',
    })

    expect(result.created).toBe(true)
    expect(readFileSync(archiveFilePath(result.storedName), 'utf8')).toBe(content)
  })

  it('落盘即只读，而只读不妨碍删除', async () => {
    const result = await commitFromTemp(staged(`read-only-${String(Date.now())}`), 'readonly.pdf', {
      messageId: MESSAGE,
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
  it('把相对路径接到归档目录后面（账号 / 消息ID / files 都在 Path 里）', async () => {
    const result = await commitFromTemp(staged(`path-${String(Date.now())}`), 'p.pdf', {
      messageId: MESSAGE,
      openedAt: AT,
    })

    expect(archiveFilePath(result.storedName)).toBe(
      join(archive, ACCOUNT, MESSAGE, 'files', 'p.pdf'),
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

  it('消息子目录里的正文照样计入（统计要递归）', async () => {
    const content = `counted-${String(Date.now())}`
    const before = usage()

    const result = await commitFromTemp(staged(content), 'counted.pdf', {
      messageId: MESSAGE,
      openedAt: AT,
    })
    const after = usage()

    expect(statSync(archiveFilePath(result.storedName)).size).toBe(content.length)
    expect(after.files).toBe(before.files + 1)
    expect(after.bytes).toBe(before.bytes + content.length)
  })

  it('同一份内容的多个名字只算一份（按 inode 去重，跨消息目录也成立）', async () => {
    const content = `usage-alias-${String(Date.now())}`
    const first = await commitFromTemp(staged(content), 'a.pdf', {
      messageId: MESSAGE,
      openedAt: AT,
    })
    const before = usage()

    await commitFromTemp(staged(content), 'b.pdf', {
      messageId: MESSAGE,
      openedAt: AT,
      findStored: (hash) => (hash === first.hash ? first.storedName : null),
    })

    // 多了一个名字，但占用不变 —— 这正是硬链接的意义，也是"按 inode 去重"存在的理由。
    expect(bodies()).toContain(`${DIR}/b.pdf`)
    expect(usage()).toEqual(before)
  })
})

describe('evictToFit', () => {
  /** 一份内容的最小候选（一个名字）。每条用例只关心自己那几个字段。 */
  function candidate(
    result: { hash: string; bytes: number; storedName: string },
    lastAccessedAt: number,
  ): EvictionCandidate {
    return {
      hash: result.hash,
      bytes: result.bytes,
      storedNames: [result.storedName],
      lastAccessedAt,
    }
  }

  it('按最久未访问优先淘汰，而不是按候选给出的顺序', async () => {
    const stamp = Date.now()
    const old = await commitFromTemp(staged(`evict-old-${stamp}`), `旧-${stamp}.pdf`, {
      messageId: MESSAGE,
      openedAt: AT,
    })
    const fresh = await commitFromTemp(staged(`evict-new-${stamp}`), `新-${stamp}.pdf`, {
      messageId: MESSAGE,
      openedAt: AT,
    })

    // 只差一个字节：必须删掉至少一份。
    const evicted = evictToFit(usage().bytes - 1, [
      // 顺序刻意把"新的"排在前面 —— 排序必须由 lastAccessedAt 决定。
      candidate(fresh, 2_000),
      candidate(old, 1_000),
    ])

    expect(evicted).toEqual([old.hash])
    expect(existsSync(archiveFilePath(old.storedName))).toBe(false)
    expect(existsSync(archiveFilePath(fresh.storedName))).toBe(true)
  })

  it('一份内容的全部磁盘名一起删（删一个硬链接名不释放任何字节）', async () => {
    const stamp = Date.now()
    const content = `evict-alias-${stamp}`
    const first = await commitFromTemp(staged(content), `别名甲-${stamp}.pdf`, {
      messageId: MESSAGE,
      openedAt: AT,
    })
    const second = await commitFromTemp(staged(content), `别名乙-${stamp}.pdf`, {
      messageId: MESSAGE,
      openedAt: AT,
      findStored: (hash) => (hash === first.hash ? first.storedName : null),
    })

    // 两个名字、同一个 inode。目标正好是"腾出这一份内容"。
    const evicted = evictToFit(usage().bytes - content.length, [
      { ...candidate(first, 1), storedNames: [first.storedName, second.storedName] },
    ])

    expect(evicted).toEqual([first.hash])
    expect(existsSync(archiveFilePath(first.storedName))).toBe(false)
    expect(existsSync(archiveFilePath(second.storedName))).toBe(false)
  })

  it('只删候选里的名字：归档目录里索引不认识的文件一个都不碰', async () => {
    const stamp = Date.now()
    const known = await commitFromTemp(staged(`evict-known-${stamp}`), `已知-${stamp}.pdf`, {
      messageId: MESSAGE,
      openedAt: AT,
    })

    // 用户自己放进来（或旧布局遗留）的文件：索引不认识它，淘汰没有理由碰它。
    mkdirSync(join(archive, DIR), { recursive: true })
    const strayRelative = `${DIR}/来路不明-${stamp}.pdf`
    writeFileSync(archiveFilePath(strayRelative), 'not ours')

    const evicted = evictToFit(usage().bytes - known.bytes, [candidate(known, 1)])

    expect(evicted).toEqual([known.hash])
    expect(existsSync(archiveFilePath(known.storedName))).toBe(false)
    // 关键：已经清到"不超过上限"了，但这个来路不明的文件还在 —— 上限宁可没能达成，
    // 也不去删一个我们说不清来历的文件。
    expect(existsSync(archiveFilePath(strayRelative))).toBe(true)
  })

  it('候选指向的文件已经不在时，回传它的哈希（清掉那条悬空记录就是修复）', async () => {
    const stamp = Date.now()
    const live = await commitFromTemp(staged(`evict-live-${stamp}`), `活着-${stamp}.pdf`, {
      messageId: MESSAGE,
      openedAt: AT,
    })
    const dangling = 'a'.repeat(64)

    const evicted = evictToFit(usage().bytes - live.bytes, [
      {
        hash: dangling,
        bytes: 999,
        storedNames: [`${DIR}/早就没了-${stamp}.pdf`],
        lastAccessedAt: 1,
      },
      candidate(live, 2),
    ])

    // 悬空的那份释放不了字节，于是循环继续到下一份 —— 两条哈希都该回传。
    expect(evicted).toEqual([dangling, live.hash])
    expect(existsSync(archiveFilePath(live.storedName))).toBe(false)
  })

  it('上限 <= 0（不限制）或占用已达标时不删任何东西', async () => {
    const stamp = Date.now()
    const kept = await commitFromTemp(staged(`evict-keep-${stamp}`), `保留-${stamp}.pdf`, {
      messageId: MESSAGE,
      openedAt: AT,
    })

    expect(evictToFit(0, [candidate(kept, 1)])).toEqual([])
    expect(evictToFit(-1, [candidate(kept, 1)])).toEqual([])
    expect(evictToFit(Number.NaN, [candidate(kept, 1)])).toEqual([])
    expect(evictToFit(usage().bytes, [candidate(kept, 1)])).toEqual([])
    expect(existsSync(archiveFilePath(kept.storedName))).toBe(true)
  })
})
