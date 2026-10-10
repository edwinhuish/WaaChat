/**
 * 归档落盘的单测。
 *
 * 这一层要保证四件事，每一件都对应一个具体的坏结果：
 *
 *   1. **归档目录里永远不存在半成品** —— 靠"先算哈希、再原子改名"的顺序拿到；
 *   2. **文件名是用户认得的原名**（同名冲突时带一小段哈希），否则目录就没法直接看（[ADR-0031]）；
 *   3. **正文只读**，而只读不妨碍删除（否则清理与淘汰都会在只读文件上失败）；
 *   4. **落在 `<账号>/<会话ID>/files/` 里**且那几级目录也是 `0700`（[ADR-0052] / [ADR-0055]）——
 *      会话ID 拼错会让文件落进别人那个会话的目录，目录权限没收紧则会让明文可被同机他人读取。
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
  symlinkSync,
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
  pruneEmptyFolders,
  removeStoredFile,
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
/** 两个不同的会话（个人会话 + 群会话）：用来验证"同名不冲突 / 同内容挂硬链接"两条行为。
 *  长度都在 8 以上，满足 `isChatSegment()`（迁移的容器判据）。 */
const CHAT = '18665597400@c.us'
const CHAT_OTHER = '120363012345678901@g.us'
/** `stored_name` 的前缀：`<账号>/<会话ID>/files`（[ADR-0055]）。 */
const DIR = `${ACCOUNT}/${CHAT}/files`
const DIR_OTHER = `${ACCOUNT}/${CHAT_OTHER}/files`
/** 拿不到会话ID时的回落目录（与账号回落对称）。 */
const DIR_FALLBACK = `${ACCOUNT}/unknown-chat/files`

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

/** 归档目录里的**正文**，相对路径（`<账号>/<会话ID>/files/合同.pdf`）。 */
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
  it('用原文名落盘，而不是哈希名；并落在 <账号>/<会话ID>/files/ 里', async () => {
    const temp = staged('hello waachat')

    const result = await commitFromTemp(temp, '报告 2026Q3.pdf', {
      chatId: CHAT,
      openedAt: AT,
    })

    expect(result.created).toBe(true)
    expect(result.hash).toBe(sha256('hello waachat'))
    expect(result.storedName).toBe(`${DIR}/报告 2026Q3.pdf`)
    expect(result.bytes).toBe('hello waachat'.length)
    expect(existsSync(temp)).toBe(false) // rename 而不是 copy：临时名不该留下
    expect(readFileSync(archiveFilePath(result.storedName), 'utf8')).toBe('hello waachat')
  })

  it('账号 / 会话ID / files 三级目录按需创建，且与归档目录同样是 0700', async () => {
    await commitFromTemp(staged(`perm-${String(Date.now())}`), 'perm.pdf', {
      chatId: CHAT,
      openedAt: AT,
    })

    // 三级都是我们建的：mkdir 的 mode 只对新建的目录生效，因此这条断言守的是
    // "里面是解密后的明文"那道权限线在子目录上也没漏（[ADR-0052]）。
    expect(statSync(join(archive, ACCOUNT)).mode & 0o777).toBe(0o700)
    expect(statSync(join(archive, ACCOUNT, CHAT)).mode & 0o777).toBe(0o700)
    expect(statSync(join(archive, ACCOUNT, CHAT, 'files')).mode & 0o777).toBe(0o700)
  })

  it('拿不到会话ID时落进 unknown-chat（与账号回落对称）', async () => {
    const name = `无会话-${String(Date.now())}.pdf`

    const result = await commitFromTemp(staged(`no-chat-${String(Date.now())}`), name, {
      openedAt: AT,
    })

    expect(result.storedName).toBe(`${DIR_FALLBACK}/${name}`)
    expect(existsSync(archiveFilePath(result.storedName))).toBe(true)
  })

  it('会话ID 需要净化时（含路径分隔符）先净化再当目录名，`@` 保留', async () => {
    const name = `净化-${String(Date.now())}.pdf`

    const result = await commitFromTemp(staged(`sanitize-${String(Date.now())}`), name, {
      chatId: '18665597400/c@us',
      openedAt: AT,
    })

    expect(result.storedName).toBe(`${ACCOUNT}/18665597400c@us/files/${name}`)
  })

  it('同名同内容命中去重，并丢弃临时文件', async () => {
    const content = `dup-${String(Date.now())}`

    const first = await commitFromTemp(staged(content), '合同.pdf', {
      chatId: CHAT,
      openedAt: AT,
    })
    const second = await commitFromTemp(staged(content), '合同.pdf', {
      chatId: CHAT,
      openedAt: AT,
    })

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.storedName).toBe(first.storedName)

    // 关键断言：去重命中的临时文件必须被清掉，否则重复打开同一个文件会不断留下垃圾。
    expect(readdirSync(archive).filter((name) => name.startsWith('.part-'))).toHaveLength(0)
  })

  it('同一个会话的目录里同名不同内容时给后者加一段哈希后缀（绝不覆盖）', async () => {
    const first = await commitFromTemp(staged(`first-${String(Date.now())}`), '合同.pdf', {
      chatId: CHAT,
      openedAt: AT,
    })
    const second = await commitFromTemp(staged(`second-${String(Date.now())}`), '合同.pdf', {
      chatId: CHAT,
      openedAt: AT,
    })

    expect(second.storedName).not.toBe(first.storedName)
    expect(leaf(second.storedName).startsWith('合同 (')).toBe(true)
    expect(leaf(second.storedName).endsWith(').pdf')).toBe(true)

    // 两份内容都还在，谁也没被覆盖 —— 覆盖一份用户可能只有一份的文件是最不可接受的失败。
    expect(readFileSync(archiveFilePath(first.storedName), 'utf8')).toContain('first-')
    expect(readFileSync(archiveFilePath(second.storedName), 'utf8')).toContain('second-')
  })

  it('不同会话里的同名文件互不冲突，各自用原名（分区带来的好处）', async () => {
    // 名字带上时间戳：这条断言关心的是**两个会话之间**没有冲突，不该被别的用例留在同一个
    // 会话目录里的同名文件影响。
    const name = `跨会话合同-${String(Date.now())}.pdf`

    const first = await commitFromTemp(staged(`one-${String(Date.now())}`), name, {
      chatId: CHAT,
      openedAt: AT,
    })
    const second = await commitFromTemp(staged(`two-${String(Date.now())}`), name, {
      chatId: CHAT_OTHER,
      openedAt: AT,
    })

    expect(first.storedName).toBe(`${DIR}/${name}`)
    expect(second.storedName).toBe(`${DIR_OTHER}/${name}`)
    expect(readFileSync(archiveFilePath(second.storedName), 'utf8')).toContain('two-')
  })

  it('同一份内容换个名字时只多一个名字，不多占字节', async () => {
    const content = `alias-${String(Date.now())}`
    const first = await commitFromTemp(staged(content), '报告.pdf', {
      chatId: CHAT,
      openedAt: AT,
    })

    const second = await commitFromTemp(staged(content), '报价单.pdf', {
      chatId: CHAT,
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

  it('同一份内容出现在另一个会话里时，在那个会话目录里挂硬链接（占用不变）', async () => {
    const content = `cross-chat-${String(Date.now())}`
    const name = `跨会话报告-${String(Date.now())}.pdf`

    const first = await commitFromTemp(staged(content), name, {
      chatId: CHAT,
      openedAt: AT,
    })
    const before = usage()

    const second = await commitFromTemp(staged(content), name, {
      chatId: CHAT_OTHER,
      openedAt: AT,
      findStored: (hash) => (hash === first.hash ? first.storedName : null),
    })

    expect(second.created).toBe(false)
    expect(second.storedName).toBe(`${DIR_OTHER}/${name}`)
    // 两个会话各有一个名字、同一个 inode：目录按会话分区，但"同一份内容只存一份"这条
    // 不变量不变（[ADR-0052] / [ADR-0055]）。
    expect(statSync(archiveFilePath(second.storedName)).ino).toBe(
      statSync(archiveFilePath(first.storedName)).ino,
    )
    expect(usage()).toEqual(before)
  })

  it('索引给的线索指向一个已经不存在的文件时，老老实实写一份新的', async () => {
    const content = `stale-${String(Date.now())}`

    const result = await commitFromTemp(staged(content), 'x.pdf', {
      chatId: CHAT,
      openedAt: AT,
      findStored: () => '早就没了的名字.pdf',
    })

    expect(result.created).toBe(true)
    expect(readFileSync(archiveFilePath(result.storedName), 'utf8')).toBe(content)
  })

  it('落盘即只读，而只读不妨碍删除', async () => {
    const result = await commitFromTemp(staged(`read-only-${String(Date.now())}`), 'readonly.pdf', {
      chatId: CHAT,
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
  it('把相对路径接到归档目录后面（账号 / 会话ID / files 都在 Path 里）', async () => {
    const result = await commitFromTemp(staged(`path-${String(Date.now())}`), 'p.pdf', {
      chatId: CHAT,
      openedAt: AT,
    })

    expect(archiveFilePath(result.storedName)).toBe(join(archive, ACCOUNT, CHAT, 'files', 'p.pdf'))
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

  it('会话子目录里的正文照样计入（统计要递归）', async () => {
    const content = `counted-${String(Date.now())}`
    const before = usage()

    const result = await commitFromTemp(staged(content), 'counted.pdf', {
      chatId: CHAT,
      openedAt: AT,
    })
    const after = usage()

    expect(statSync(archiveFilePath(result.storedName)).size).toBe(content.length)
    expect(after.files).toBe(before.files + 1)
    expect(after.bytes).toBe(before.bytes + content.length)
  })

  it('同一份内容的多个名字只算一份（按 inode 去重，跨会话目录也成立）', async () => {
    const content = `usage-alias-${String(Date.now())}`
    const first = await commitFromTemp(staged(content), 'a.pdf', {
      chatId: CHAT,
      openedAt: AT,
    })
    const before = usage()

    await commitFromTemp(staged(content), 'b.pdf', {
      chatId: CHAT,
      openedAt: AT,
      findStored: (hash) => (hash === first.hash ? first.storedName : null),
    })

    // 多了一个名字，但占用不变 —— 这正是硬链接的意义，也是"按 inode 去重"存在的理由。
    expect(bodies()).toContain(`${DIR}/b.pdf`)
    expect(usage()).toEqual(before)
  })
})

describe('removeStoredFile', () => {
  it('删掉正文，磁盘上的那个名字确实不见了，占用跟着降下来', async () => {
    const name = `删掉-${String(Date.now())}.pdf`
    const result = await commitFromTemp(staged(`doomed-${String(Date.now())}`), name, {
      chatId: CHAT,
      openedAt: AT,
    })
    const path = archiveFilePath(result.storedName)
    const before = usage()

    expect(existsSync(path)).toBe(true)
    expect(removeStoredFile(result.storedName)).toBe(true)

    expect(existsSync(path)).toBe(false)
    expect(usage().files).toBe(before.files - 1)
  })

  it('只删这一个名字：同一份内容的另一个名字（硬链接）不受影响，也不释放字节', async () => {
    const content = `shared-${String(Date.now())}`
    const first = await commitFromTemp(staged(content), `共享甲-${String(Date.now())}.pdf`, {
      chatId: CHAT,
      openedAt: AT,
    })
    const second = await commitFromTemp(staged(content), `共享乙-${String(Date.now())}.pdf`, {
      chatId: CHAT_OTHER,
      openedAt: AT,
      findStored: (hash) => (hash === first.hash ? first.storedName : null),
    })
    const before = usage()

    expect(removeStoredFile(first.storedName)).toBe(true)

    expect(existsSync(archiveFilePath(first.storedName))).toBe(false)
    // 另一个会话里那一份还在，占用一个字节都没少 —— "删一条 ≠ 腾空间"（[ADR-0053]）。
    expect(existsSync(archiveFilePath(second.storedName))).toBe(true)
    expect(usage()).toEqual(before)
  })

  it('名字本来就不在时也算成功（那正是目标状态，不是失败）', () => {
    expect(removeStoredFile(`${ACCOUNT}/${CHAT}/files/从来就没有过.pdf`)).toBe(true)
  })

  it('名字指向目录时拒绝，并且**不**递归删（那不是我们写下的正文）', () => {
    const relative = `${ACCOUNT}/${CHAT}/files/是个目录-${String(Date.now())}`
    mkdirSync(archiveFilePath(relative), { recursive: true })

    expect(removeStoredFile(relative)).toBe(false)
    expect(existsSync(archiveFilePath(relative))).toBe(true)
  })

  it('索引被改坏时删不到归档外面去（`..` 会被剥掉）', () => {
    // 归档目录**外面**的文件：一次路径穿越就会毁掉用户的别的东西。
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'keep me')

    expect(removeStoredFile('../../outside.txt')).toBe(true)

    expect(existsSync(outside)).toBe(true)
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
      chatId: CHAT,
      openedAt: AT,
    })
    const fresh = await commitFromTemp(staged(`evict-new-${stamp}`), `新-${stamp}.pdf`, {
      chatId: CHAT,
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
      chatId: CHAT,
      openedAt: AT,
    })
    const second = await commitFromTemp(staged(content), `别名乙-${stamp}.pdf`, {
      chatId: CHAT,
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
      chatId: CHAT,
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
      chatId: CHAT,
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
      chatId: CHAT,
      openedAt: AT,
    })

    expect(evictToFit(0, [candidate(kept, 1)])).toEqual([])
    expect(evictToFit(-1, [candidate(kept, 1)])).toEqual([])
    expect(evictToFit(Number.NaN, [candidate(kept, 1)])).toEqual([])
    expect(evictToFit(usage().bytes, [candidate(kept, 1)])).toEqual([])
    expect(existsSync(archiveFilePath(kept.storedName))).toBe(true)
  })
})

/**
 * 删除路径上的善后（[ADR-0054]）：删掉某个会话的最后一份正文后，那几层空目录应当一起消失，
 * 而不是在用户的归档目录里留一串既解释不了也点不开的空壳。
 *
 * 每个用例都用**自己的**归档目录：这一组要断言的恰恰是"删到最后连账号那一层也没了"，
 * 而上面那些 describe 的用例都在共享目录里留下了正文 —— 混在一起时账号那一层永远非空，
 * 断言就变成了假的。
 */
describe('pruneEmptyFolders', () => {
  /** 换到一个干净的归档目录（`setArchiveDir()` 改的是模块级状态，因此必须在结束时复位）。 */
  function freshArchive(name: string): string {
    const dir = join(root, `prune-${name}`)
    setArchiveDir(dir)
    ensureArchiveDir()

    return dir
  }

  afterAll(() => {
    setArchiveDir(archive)
  })

  it('删掉一个会话的最后一份正文后，会话目录与账号那一层一起消失，归档根留着', async () => {
    const own = freshArchive('last')
    const chat = '18665597401@c.us'
    const result = await commitFromTemp(staged('prune-last'), 'p.pdf', {
      chatId: chat,
      openedAt: AT,
    })
    const dir = join(own, ACCOUNT, chat)

    expect(existsSync(join(dir, 'files', 'p.pdf'))).toBe(true)
    expect(removeStoredFile(result.storedName)).toBe(true)

    pruneEmptyFolders(result.storedName)

    expect(existsSync(dir)).toBe(false)
    expect(existsSync(join(own, ACCOUNT))).toBe(false)
    // 归档根本身不碰：它是用户可见的落点，由 `ensureArchiveDir()` 保证存在。
    expect(existsSync(own)).toBe(true)
  })

  it('同一个会话里还有别的正文时停在那一层（绝不删非空目录）', async () => {
    const own = freshArchive('keep')
    const chat = '18665597402@c.us'
    const kept = await commitFromTemp(staged('prune-keep-a'), '留.pdf', {
      chatId: chat,
      openedAt: AT,
    })
    const gone = await commitFromTemp(staged('prune-keep-b'), '删.pdf', {
      chatId: chat,
      openedAt: AT,
    })

    expect(removeStoredFile(gone.storedName)).toBe(true)
    pruneEmptyFolders(gone.storedName)

    expect(existsSync(archiveFilePath(kept.storedName))).toBe(true)
    expect(existsSync(join(own, ACCOUNT, chat, 'files'))).toBe(true)
  })

  it('容器是符号链接时跳过它（INVARIANTS G-4）', () => {
    const own = freshArchive('symlink')
    const chat = '18665597403@c.us'
    const container = join(own, ACCOUNT, chat)
    const outside = join(root, 'outside-empty')
    mkdirSync(container, { recursive: true })
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(container, 'files'))

    pruneEmptyFolders(`${ACCOUNT}/${chat}/files/正文.pdf`)

    // 归档目录内不跟随符号链接 —— 跳过它，也就不会顺着它清掉归档**外面**的目录。
    expect(existsSync(join(container, 'files'))).toBe(true)
    expect(existsSync(outside)).toBe(true)
  })

  it('[ADR-0052] 留下的消息ID 目录同样会被收掉（老数据不必手工清）', async () => {
    const own = freshArchive('legacy-message')
    const message = '3EB0A1B2C3D4E5F6A7B8'
    const result = await commitFromTemp(staged('prune-legacy'), '旧.pdf', {
      chatId: message,
      openedAt: AT,
    })

    expect(removeStoredFile(result.storedName)).toBe(true)
    pruneEmptyFolders(result.storedName)

    expect(existsSync(join(own, ACCOUNT, message))).toBe(false)
  })

  it('旧布局的空年月目录同样收掉（[ADR-0037] / [ADR-0039]）', () => {
    const own = freshArchive('legacy')
    const month = join(own, ACCOUNT, 'files', '2026-10')
    mkdirSync(month, { recursive: true })

    pruneEmptyFolders(`${ACCOUNT}/files/2026-10/旧.pdf`)

    expect(existsSync(month)).toBe(false)
    expect(existsSync(join(own, ACCOUNT))).toBe(false)
  })

  it('平面布局的裸文件名没有容器可清（也不会去动归档根）', () => {
    const own = freshArchive('flat')

    pruneEmptyFolders('旧文件.pdf')

    expect(existsSync(own)).toBe(true)
  })

  it('单删一个名字不负责清容器 —— 清理是删除路径的职责（[ADR-0054]）', async () => {
    const own = freshArchive('scope')
    const chat = '18665597409@c.us'
    const result = await commitFromTemp(staged('prune-scope'), 'x.pdf', {
      chatId: chat,
      openedAt: AT,
    })

    expect(removeStoredFile(result.storedName)).toBe(true)

    // `removeStoredFile()` 与淘汰（`evictToFit()`）是两套语义，因此清理只能由调用方显式要求：
    // 把清理塞进 `removeStoredFile()` 会让淘汰也悄悄开始删目录。
    expect(existsSync(join(own, ACCOUNT, chat, 'files'))).toBe(true)
  })
})
