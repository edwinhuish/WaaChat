/**
 * 内容寻址存储的单测。
 *
 * 这一层要保证的是**归档目录里永远不存在半成品**，以及去重不依赖任何判断逻辑。
 * 两个性质都是靠"先算哈希、再原子改名"的顺序拿到的，因此测试用真实文件系统
 * （在隔离的归档目录下），而不是 mock `node:fs` —— mock 掉 fs 之后，
 * 被测的恰好就只剩"我有没有按顺序调用它们"，而顺序正是最容易看出来的东西。
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  blobPath,
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
  // 否则这些用例会写进开发者本机真实的 `~/Downloads/WaaChat_files`。
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

describe('commitFromTemp', () => {
  it('把临时文件原子改名成哈希名', async () => {
    const temp = staged('hello waachat')

    const result = await commitFromTemp(temp)

    expect(result.created).toBe(true)
    expect(result.hash).toBe(sha256('hello waachat'))
    expect(existsSync(temp)).toBe(false) // rename 而不是 copy：临时名不该留下
    expect(readFileSync(blobPath(result.hash), 'utf8')).toBe('hello waachat')
  })

  it('相同内容第二次提交时命中去重，且丢弃临时文件', async () => {
    const content = `dup-${String(Date.now())}`

    const first = await commitFromTemp(staged(content))
    const second = await commitFromTemp(staged(content))

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.hash).toBe(first.hash)

    // 关键断言：去重命中的临时文件必须被清掉，否则重复打开同一个文件会不断留下垃圾。
    expect(readdirSync(archive).filter((name) => name.startsWith('.part-'))).toHaveLength(0)
  })

  it('不同内容得到不同的哈希名', async () => {
    const a = await commitFromTemp(staged(`a-${String(Date.now())}`))
    const b = await commitFromTemp(staged(`b-${String(Date.now())}`))

    expect(a.hash).not.toBe(b.hash)
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
  it('只统计正文，跳过内部条目', () => {
    // `.open/` 是为打开而建的硬链接目录，把它算进来会让占用翻倍。
    mkdirSync(join(archive, '.open', 'somehash'), { recursive: true })
    writeFileSync(join(archive, '.open', 'somehash', 'file.pdf'), 'x')

    const { files, bytes } = usage()

    expect(files).toBe(readdirSync(archive).filter((n) => !n.startsWith('.')).length)
    expect(bytes).toBeGreaterThan(0)
  })

  it('索引文件（点开头）不计入占用', () => {
    // 索引就在归档目录里（ADR-0018），它既不是正文，也不该被统计。
    writeFileSync(join(archive, '.index.sqlite'), 'not a real database')

    const { files } = usage()

    expect(files).toBe(readdirSync(archive).filter((n) => !n.startsWith('.')).length)
  })
})
