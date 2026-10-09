/**
 * 密文缓存磁盘侧的单测。
 *
 * 这层要做的是"让磁盘状态与设置一致"，而它的手段里包含**删除** —— 因此每条用例都跑在
 * 真实文件系统上（隔离在临时的 `XDG_DATA_HOME` 里），断言"删了什么、留了什么"。
 * mock 掉 `node:fs` 之后，被测的就只剩"我按顺序调用了哪些函数"，而那是最容易看出来的东西。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  CACHE_DIR_MODE,
  orphanEntries,
  reconcileCiphertextCache,
} from '../../src/main/capture/cache-files'
import { ciphertextCacheDir } from '../../src/main/paths'

/** 一对正常的条目。 */
const PAIR_ID = 'a'.repeat(64)
const BODY = `${PAIR_ID}.bin`
const META = `${PAIR_ID}.meta.json`

/** 只有正文、没有元信息（进程被 kill 在两次写之间留下的那种）。 */
const HALF_BODY = `${'b'.repeat(64)}.bin`
/** 只有元信息、没有正文。 */
const HALF_META = `${'c'.repeat(64)}.meta.json`

let root: string
let previousDataHome: string | undefined

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'waachat-cache-files-'))

  /**
   * 缓存目录由 `XDG_DATA_HOME` 推导（`main/paths.ts`），因此把整个 XDG 数据目录指到临时
   * 目录里 —— 否则这些用例会去动开发者本机真实的 `~/.local/share/waachat/cache`。
   */
  previousDataHome = process.env['XDG_DATA_HOME']
  process.env['XDG_DATA_HOME'] = root
})

afterAll(() => {
  // 复位进程级状态：同一个进程里的其它用例不该继承这个临时目录。
  if (previousDataHome === undefined) delete process.env['XDG_DATA_HOME']
  else process.env['XDG_DATA_HOME'] = previousDataHome

  rmSync(root, { recursive: true, force: true })
})

const dir = (): string => ciphertextCacheDir()

/** 每个用例从一个空的缓存目录开始（目录存在，但什么都没有）。 */
function resetDir(): void {
  rmSync(dir(), { recursive: true, force: true })
  mkdirSync(dir(), { recursive: true, mode: CACHE_DIR_MODE })
}

afterEach(() => {
  resetDir()
})

function write(name: string, content = 'x'): void {
  writeFileSync(join(dir(), name), content)
}

function names(): string[] {
  return readdirSync(dir()).sort()
}

describe('orphanEntries', () => {
  it('成对的条目不算残留', () => {
    expect(orphanEntries([BODY, META])).toEqual([])
  })

  it('缺一半的条目就是残留', () => {
    expect(orphanEntries([BODY, HALF_BODY, HALF_META, META]).sort()).toEqual(
      [HALF_BODY, HALF_META].sort(),
    )
  })

  it('不认识的扩展名不是残留（那不是我们写的）', () => {
    expect(orphanEntries(['notes.txt', 'x.bin.part'])).toEqual([])
  })
})

describe('reconcileCiphertextCache（关闭）', () => {
  it('清掉我们写的所有条目，包括缺一半的', () => {
    write(BODY, 'body')
    write(META, 'meta')
    write(HALF_BODY, 'partial')

    const result = reconcileCiphertextCache(false)

    expect(names()).toEqual([])
    expect(result).toMatchObject({ removed: 3, kept: 0, foreign: 0 })
    // 字节数用于日志里回答"这一下省了多少磁盘"。
    expect(result.bytes).toBe('body'.length + 'meta'.length + 'partial'.length)
  })

  it('不动不是缓存条目的东西', () => {
    write(BODY, 'body')
    write('notes.txt', 'mine')
    mkdirSync(join(dir(), 'somedir'))

    const result = reconcileCiphertextCache(false)

    // 目录是这个目录里的外来物：不认识就不删，但要能被看见（日志里会 warn）。
    expect(names()).toEqual(['notes.txt', 'somedir'])
    expect(result).toMatchObject({ removed: 1, kept: 0, foreign: 2 })
  })

  it('目录不存在时什么都不做，也不创建它', () => {
    rmSync(dir(), { recursive: true, force: true })

    const result = reconcileCiphertextCache(false)

    expect(result).toEqual({ removed: 0, bytes: 0, kept: 0, foreign: 0 })
    // 默认关闭的新机器上就不该有这个目录 —— 它只有 `attachCiphertextCache()` 会建。
    expect(existsSync(dir())).toBe(false)
  })

  it('是幂等的：清干净之后再跑一次没有任何动作', () => {
    write(BODY)
    write(META)

    expect(reconcileCiphertextCache(false).removed).toBe(2)
    expect(reconcileCiphertextCache(false)).toEqual({ removed: 0, bytes: 0, kept: 0, foreign: 0 })
  })
})

describe('reconcileCiphertextCache（开启）', () => {
  it('保留可命中的条目 —— 这就是"关掉又开回来不用重新下载"', () => {
    write(BODY, 'body')
    write(META, 'meta')

    const result = reconcileCiphertextCache(true)

    expect(names()).toEqual([BODY, META].sort())
    expect(result).toMatchObject({ removed: 0, kept: 2, foreign: 0 })
  })

  it('清掉不可能命中的残留，保留成对的条目', () => {
    write(BODY)
    write(META)
    write(HALF_BODY)
    write(HALF_META)

    const result = reconcileCiphertextCache(true)

    expect(names()).toEqual([BODY, META].sort())
    expect(result).toMatchObject({ removed: 2, kept: 2, foreign: 0 })
  })

  it('版本不符的条目**不**在这里清（同一个 URL 再次请求时会原地覆盖，本来就会自愈）', () => {
    write(BODY, 'old-format-body')
    write(META, `${JSON.stringify({ version: 1, url: 'https://x/', headers: {} })}\n`)

    const result = reconcileCiphertextCache(true)

    // 清掉它要读一遍所有 meta（缓存上限 2 GiB、条目可能上万），代价与收益不成比例。
    expect(names()).toEqual([BODY, META].sort())
    expect(result).toMatchObject({ removed: 0, kept: 2 })
  })

  it('不动不是缓存条目的东西', () => {
    write(BODY)
    write(META)
    write('notes.txt')
    // 名字看起来像条目、其实是个目录：只处理普通文件，因此原样留着。
    mkdirSync(join(dir(), `${'d'.repeat(64)}.bin`))

    const result = reconcileCiphertextCache(true)

    expect(names()).toEqual([BODY, META, 'notes.txt', `${'d'.repeat(64)}.bin`].sort())
    expect(result).toMatchObject({ removed: 0, kept: 2, foreign: 2 })
  })
})
