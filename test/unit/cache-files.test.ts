/**
 * 密文缓存磁盘侧的单测。
 *
 * 这层要做的是"让磁盘状态与设置一致"，而它的手段里包含**删除**与**搬运** —— 因此每条
 * 用例都跑在真实文件系统上（隔离在临时的 `XDG_DATA_HOME` 里），断言"删了什么、搬了什么、
 * 留下了什么"。mock 掉 `node:fs` 之后，被测的就只剩"我按顺序调用了哪些函数"。
 *
 * 两个关键词分清（ADR-0027）：
 *   转换（convert）—— 用户发起的一次切换，可回退
 *   对账（reconcile）—— 启动时的兜底，幂等
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  CACHE_DIR_MODE,
  convertCache,
  orphanEntries,
  planCacheConversion,
  purgeStaging,
  reconcileCiphertextCache,
  recoverStaging,
  restoreStaging,
  stagingDir,
  type CacheConversionPlan,
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

/** 缓存目录里"看得见的东西"：把暂存区排除掉 —— 它是实现细节，不是条目。 */
function names(): string[] {
  return readdirSync(dir())
    .filter((name) => name !== '.staging')
    .sort()
}

function staged(): string[] {
  return readdirSync(stagingDir()).sort()
}

/** 造出"进程在转换途中被杀"的现场：条目已经在暂存区，而设置从未提交。 */
function simulateInterruptedConversion(...entries: string[]): void {
  mkdirSync(stagingDir(), { recursive: true, mode: CACHE_DIR_MODE })
  for (const name of entries) renameSync(join(dir(), name), join(stagingDir(), name))
}

/** 算一次切换的计划。读不了目录时直接让用例失败 —— 那是另一个用例的事。 */
function planOf(target: boolean): CacheConversionPlan {
  const planned = planCacheConversion(target)
  if (!planned.ok) throw new Error('planCacheConversion 失败了')
  return planned.plan
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

describe('planCacheConversion', () => {
  it('关闭方向要处理我们写的全部条目', () => {
    write(BODY, 'body')
    write(META, 'meta')
    write(HALF_BODY, 'half')
    write('notes.txt', 'mine')

    expect(planCacheConversion(false)).toEqual({
      ok: true,
      plan: { target: false, entries: 3, bytes: 12 },
    })
  })

  it('开启方向只处理不可能命中的残留', () => {
    write(BODY)
    write(META)
    write(HALF_BODY)
    write(HALF_META)

    expect(planCacheConversion(true)).toEqual({
      ok: true,
      plan: { target: true, entries: 2, bytes: 2 },
    })
  })

  it('缓存路径不是一个目录时算不出计划（此时不该开始切换）', () => {
    rmSync(dir(), { recursive: true, force: true })
    writeFileSync(dir(), 'not a directory')

    expect(planCacheConversion(false).ok).toBe(false)
    // 对账遇到同样的情况不该崩：它只是记住"这里读不了"。
    return expect(reconcileCiphertextCache(false)).resolves.toEqual({
      removed: 0,
      bytes: 0,
      kept: 0,
      foreign: 0,
    })
  })
})

describe('convertCache（关闭）', () => {
  it('把条目搬进暂存区，而不是直接删', async () => {
    write(BODY, 'body')
    write(META, 'meta')
    write(HALF_BODY, 'half')
    write('notes.txt', 'mine')

    const result = await convertCache(planOf(false))

    expect(result).toEqual({ ok: true, converted: 3, bytes: 12 })
    // 缓存目录里只剩不属于我们的东西 —— 而条目还在，只是在暂存区等着。
    expect(names()).toEqual(['notes.txt'])
    expect(staged()).toEqual([BODY, META, HALF_BODY].sort())
  })

  it('中途失败时把已经搬走的搬回原位，并报告回滚成功', async () => {
    write(BODY, 'body')
    write(META, 'meta')
    write(HALF_BODY, 'half')

    const result = await convertCache(planOf(false), {
      afterEntry: (_name, index) => {
        if (index === 1) throw new Error('boom')
      },
    })

    expect(result).toMatchObject({ ok: false, detail: 'Error', rolledBack: true })
    // 一个都不能少：这正是"失败就回到切换前的状态"。
    expect(names()).toEqual([BODY, META, HALF_BODY].sort())
    expect(existsSync(stagingDir())).toBe(false)
  })
})

describe('convertCache（开启）', () => {
  it('删掉残留，保留成对的条目', async () => {
    write(BODY, 'body')
    write(META, 'meta')
    write(HALF_BODY)
    write(HALF_META)

    const result = await convertCache(planOf(true))

    // 两个残留各 1 字节（用例里写的是 'x'）。
    expect(result).toEqual({ ok: true, converted: 2, bytes: 2 })
    expect(names()).toEqual([BODY, META].sort())
    // 这个方向不需要暂存区：残留本来就命不中，删掉不丢任何可用的东西。
    expect(existsSync(stagingDir())).toBe(false)
  })
})

describe('暂存区（回滚与中断恢复）', () => {
  it('purgeStaging 清干净并返回 0', async () => {
    write(BODY)
    write(META)

    await convertCache(planOf(false))

    expect(await purgeStaging()).toBe(0)
    expect(existsSync(stagingDir())).toBe(false)
  })

  it('搬不回去时报告回滚失败（界面据此提示人工核对）', async () => {
    write(BODY)
    simulateInterruptedConversion(BODY)

    // 目标位置上有一个非空目录，rename 会失败 —— 这正是"回滚失败"的样子。
    mkdirSync(join(dir(), BODY))
    writeFileSync(join(dir(), BODY, 'x'), 'y')

    expect(await restoreStaging()).toBe(false)
    expect(existsSync(join(stagingDir(), BODY))).toBe(true)
  })

  it('中断后以"开启"启动：搬回去（回退到切换前的状态）', async () => {
    write(BODY, 'body')
    write(META, 'meta')
    simulateInterruptedConversion(BODY)

    // 设置说"开启" ⇒ 那次切换没走到提交 ⇒ 回退。
    expect(await recoverStaging(true)).toBe(1)

    expect(names()).toEqual([BODY, META].sort())
    expect(existsSync(stagingDir())).toBe(false)
  })

  it('中断后以"关闭"启动：删掉暂存区（完成收尾）', async () => {
    write(BODY)
    write(META)
    simulateInterruptedConversion(BODY, META)

    // 设置说"关闭" ⇒ 提交已经发生，只剩收尾 ⇒ 完成它。
    expect(await recoverStaging(false)).toBe(0)

    expect(existsSync(stagingDir())).toBe(false)
    expect(names()).toEqual([])
  })
})

describe('reconcileCiphertextCache（关闭）', () => {
  it('清掉我们写的所有条目，包括缺一半的', async () => {
    write(BODY, 'body')
    write(META, 'meta')
    write(HALF_BODY, 'partial')

    const result = await reconcileCiphertextCache(false)

    expect(names()).toEqual([])
    expect(result).toMatchObject({ removed: 3, kept: 0, foreign: 0 })
    // 字节数用于日志里回答"这一下省了多少磁盘"。
    expect(result.bytes).toBe('body'.length + 'meta'.length + 'partial'.length)
  })

  it('不动不是缓存条目的东西', async () => {
    write(BODY, 'body')
    write('notes.txt', 'mine')
    mkdirSync(join(dir(), 'somedir'))

    const result = await reconcileCiphertextCache(false)

    // 目录是这个目录里的外来物：不认识就不删，但要能被看见（日志里会 warn）。
    expect(names()).toEqual(['notes.txt', 'somedir'])
    expect(result).toMatchObject({ removed: 1, kept: 0, foreign: 2 })
  })

  it('目录不存在时什么都不做，也不创建它', async () => {
    rmSync(dir(), { recursive: true, force: true })

    const result = await reconcileCiphertextCache(false)

    expect(result).toEqual({ removed: 0, bytes: 0, kept: 0, foreign: 0 })
    // 对账**不建**这个目录 —— 它只有 `attachCiphertextCache()` 会建。因此目录不在时
    // 对账必须是"什么都不做"，而不是顺手把它建出来（那会把"关闭"变成"半个开启"）。
    expect(existsSync(dir())).toBe(false)
  })

  it('是幂等的：清干净之后再跑一次没有任何动作', async () => {
    write(BODY)
    write(META)

    expect((await reconcileCiphertextCache(false)).removed).toBe(2)
    await expect(reconcileCiphertextCache(false)).resolves.toEqual({
      removed: 0,
      bytes: 0,
      kept: 0,
      foreign: 0,
    })
  })

  it('先做中断恢复：暂存区里那份按"收尾"删掉，目录里剩下的按设置清掉', async () => {
    write(BODY)
    write(META)
    simulateInterruptedConversion(BODY)

    // 设置为"关闭" ⇒ 上次提交已经发生，暂存区里那份是待删的（不算 removed），
    // 目录里还在的 META 才由这次对账删掉。
    expect(await reconcileCiphertextCache(false)).toMatchObject({ removed: 1, kept: 0 })
    expect(names()).toEqual([])
    expect(existsSync(stagingDir())).toBe(false)
  })
})

describe('reconcileCiphertextCache（开启）', () => {
  it('保留可命中的条目 —— 这就是"关掉又开回来不用重新下载"', async () => {
    write(BODY, 'body')
    write(META, 'meta')

    const result = await reconcileCiphertextCache(true)

    expect(names()).toEqual([BODY, META].sort())
    expect(result).toMatchObject({ removed: 0, kept: 2, foreign: 0 })
  })

  it('清掉不可能命中的残留，保留成对的条目', async () => {
    write(BODY)
    write(META)
    write(HALF_BODY)
    write(HALF_META)

    const result = await reconcileCiphertextCache(true)

    expect(names()).toEqual([BODY, META].sort())
    expect(result).toMatchObject({ removed: 2, kept: 2, foreign: 0 })
  })

  it('版本不符的条目**不**在这里清（同一个 URL 再次请求时会原地覆盖，本来就会自愈）', async () => {
    write(BODY, 'old-format-body')
    write(META, `${JSON.stringify({ version: 1, url: 'https://x/', headers: {} })}\n`)

    const result = await reconcileCiphertextCache(true)

    // 清掉它要读一遍所有 meta（缓存上限 2 GiB、条目可能上万），代价与收益不成比例。
    expect(names()).toEqual([BODY, META].sort())
    expect(result).toMatchObject({ removed: 0, kept: 2 })
  })

  it('不动不是缓存条目的东西', async () => {
    write(BODY)
    write(META)
    write('notes.txt')
    // 名字看起来像条目、其实是个目录：只处理普通文件，因此原样留着。
    mkdirSync(join(dir(), `${'d'.repeat(64)}.bin`))

    const result = await reconcileCiphertextCache(true)

    expect(names()).toEqual([BODY, META, 'notes.txt', `${'d'.repeat(64)}.bin`].sort())
    expect(result).toMatchObject({ removed: 0, kept: 2, foreign: 2 })
  })
})
