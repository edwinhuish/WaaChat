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
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  CACHE_DIR_MODE,
  cacheSweepInterval,
  cacheUsage,
  convertCache,
  enforceCacheLimit,
  evictCacheToFit,
  fileBytes,
  listCacheEntries,
  orphanEntries,
  planCacheConversion,
  purgeStaging,
  reconcileCiphertextCache,
  recoverStaging,
  restoreStaging,
  selectCacheEvictions,
  shouldCacheEntry,
  stagingDir,
  touchCacheEntry,
  type CacheConversionPlan,
  type CacheEntry,
} from '../../src/main/capture/cache-files'
import { ciphertextCacheDir, setAccountKey } from '../../src/main/paths'

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

  /**
   * 账号标识也用固定的一个（[ADR-0039]）：`purgeStaging()` / `restoreStaging()` 这些函数
   * 不传参时取"当前账号目录"，因此这个值必须与用例里建出来的那棵树一致。
   */
  setAccountKey(ACCOUNT)
})

afterAll(() => {
  // 复位进程级状态：同一个进程里的其它用例不该继承这个临时目录与账号名。
  if (previousDataHome === undefined) delete process.env['XDG_DATA_HOME']
  else process.env['XDG_DATA_HOME'] = previousDataHome

  setAccountKey(null)
  rmSync(root, { recursive: true, force: true })
})

/** 缓存根。 */
const dir = (): string => ciphertextCacheDir()

/**
 * 条目现在落在 `<缓存根>/<账号>/<年-月>/`（[ADR-0039]）。用例固定用同一个 UUID 形状的账号名
 * 与固定的月份 —— 判据只看形状（`isAccountSegment`），因此不必真的等一个月。
 */
const ACCOUNT = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const MONTH = '2026-10'

const accountDir = (): string => join(dir(), ACCOUNT)
const entryDir = (): string => join(accountDir(), MONTH)

/** 每个用例从一个空的缓存目录开始（账号与当月目录已建好，但什么都没有）。 */
function resetDir(): void {
  rmSync(dir(), { recursive: true, force: true })
  mkdirSync(entryDir(), { recursive: true, mode: CACHE_DIR_MODE })
}

afterEach(() => {
  resetDir()
})

function write(name: string, content = 'x'): void {
  writeFileSync(join(entryDir(), name), content)
}

/** 月份目录里"看得见的东西"：把暂存区排除掉 —— 它是实现细节，不是条目。 */
function names(): string[] {
  return readdirSync(entryDir())
    .filter((name) => name !== '.staging')
    .sort()
}

function staged(): string[] {
  return readdirSync(stagingDir(entryDir())).sort()
}

/** 造出"进程在转换途中被杀"的现场：条目已经在暂存区，而设置从未提交。 */
function simulateInterruptedConversion(...entries: string[]): void {
  mkdirSync(stagingDir(entryDir()), { recursive: true, mode: CACHE_DIR_MODE })
  for (const name of entries) {
    renameSync(join(entryDir(), name), join(stagingDir(entryDir()), name))
  }
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

  it('缓存根不是目录时，计划是 0 个条目（而不是崩掉）', () => {
    rmSync(dir(), { recursive: true, force: true })
    writeFileSync(dir(), 'not a directory')

    // 没有账号目录可遍历 ⇒ 没有条目。对账同样什么都不做、也不把它建出来。
    expect(planCacheConversion(false)).toEqual({
      ok: true,
      plan: { target: false, entries: 0, bytes: 0 },
    })
    return expect(reconcileCiphertextCache(false)).resolves.toEqual({
      removed: 0,
      bytes: 0,
      kept: 0,
      foreign: 0,
    })
  })

  it('老的平铺布局整批清掉（它们在新的查找路径上永远命不中）', async () => {
    // ADR-0039 之前：条目直接躺在缓存根下。
    writeFileSync(join(dir(), BODY), 'body')
    writeFileSync(join(dir(), META), 'meta')
    // 同一层还有不属于我们的东西：不动它。
    writeFileSync(join(dir(), 'notes.txt'), 'mine')

    const result = await reconcileCiphertextCache(true)

    expect(existsSync(join(dir(), BODY))).toBe(false)
    expect(existsSync(join(dir(), META))).toBe(false)
    expect(existsSync(join(dir(), 'notes.txt'))).toBe(true)
    expect(result).toMatchObject({ removed: 2, foreign: 1 })
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
    expect(existsSync(stagingDir(entryDir()))).toBe(false)
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
    expect(existsSync(stagingDir(entryDir()))).toBe(false)
  })
})

describe('暂存区（回滚与中断恢复）', () => {
  it('purgeStaging 清干净并返回 0', async () => {
    write(BODY)
    write(META)

    await convertCache(planOf(false))

    expect(await purgeStaging(entryDir())).toBe(0)
    expect(existsSync(stagingDir(entryDir()))).toBe(false)
  })

  it('搬不回去时报告回滚失败（界面据此提示人工核对）', async () => {
    write(BODY)
    simulateInterruptedConversion(BODY)

    // 目标位置上有一个非空目录，rename 会失败 —— 这正是"回滚失败"的样子。
    mkdirSync(join(entryDir(), BODY))
    writeFileSync(join(entryDir(), BODY, 'x'), 'y')

    expect(await restoreStaging(entryDir())).toBe(false)
    expect(existsSync(join(stagingDir(entryDir()), BODY))).toBe(true)
  })

  it('中断后以"开启"启动：搬回去（回退到切换前的状态）', async () => {
    write(BODY, 'body')
    write(META, 'meta')
    simulateInterruptedConversion(BODY)

    // 设置说"开启" ⇒ 那次切换没走到提交 ⇒ 回退。
    expect(await recoverStaging(true, entryDir())).toBe(1)

    expect(names()).toEqual([BODY, META].sort())
    expect(existsSync(stagingDir(entryDir()))).toBe(false)
  })

  it('中断后以"关闭"启动：删掉暂存区（完成收尾）', async () => {
    write(BODY)
    write(META)
    simulateInterruptedConversion(BODY, META)

    // 设置说"关闭" ⇒ 提交已经发生，只剩收尾 ⇒ 完成它。
    expect(await recoverStaging(false, entryDir())).toBe(0)

    expect(existsSync(stagingDir(entryDir()))).toBe(false)
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
    mkdirSync(join(entryDir(), 'somedir'))

    const result = await reconcileCiphertextCache(false)

    // 目录与不认识的扩展名都是这个目录里的外来物：不认识就不删，但要能被看见（日志里会 warn）。
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
    expect(existsSync(stagingDir(entryDir()))).toBe(false)
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
    mkdirSync(join(entryDir(), `${'d'.repeat(64)}.bin`))

    const result = await reconcileCiphertextCache(true)

    expect(names()).toEqual([BODY, META, 'notes.txt', `${'d'.repeat(64)}.bin`].sort())
    expect(result).toMatchObject({ removed: 0, kept: 2, foreign: 2 })
  })
})

/**
 * 密文缓存的容量上限与淘汰（[ADR-0049]）。
 *
 * 淘汰是这个模块里**唯一会从用户磁盘上删文件**的动作（虽然都是我们写的），因此它比写入
 * 路径更值得断言：顺序、边界、以及"什么能动、什么一个都不碰"都钉在这里。
 */
describe('selectCacheEvictions（纯函数）', () => {
  function entry(id: string, bytes: number, usedAt: number): CacheEntry {
    return { id, dir: '/不存在', bytes, usedAt }
  }

  it('最久未用优先，够到上限就停（不多删一条）', () => {
    const entries = [entry('a', 10, 300), entry('b', 10, 100), entry('c', 10, 200)]

    // 总量 30、上限 20：删掉最旧的 b 之后正好 20 —— 达标即停。
    expect(selectCacheEvictions(entries, 30, 20).map((one) => one.id)).toEqual(['b'])
  })

  it('需要删多条时按 usedAt 升序，与数组顺序无关', () => {
    const entries = [entry('a', 10, 300), entry('b', 10, 100), entry('c', 10, 200)]

    expect(selectCacheEvictions(entries, 30, 5).map((one) => one.id)).toEqual(['b', 'c', 'a'])
  })

  it('不超标 / 上限为 0（不限制）/ 上限不合法时一条都不删', () => {
    const entries = [entry('a', 10, 1)]

    expect(selectCacheEvictions(entries, 10, 10)).toEqual([])
    expect(selectCacheEvictions(entries, 10, 0)).toEqual([])
    expect(selectCacheEvictions(entries, 10, -1)).toEqual([])
    expect(selectCacheEvictions(entries, 10, Number.NaN)).toEqual([])
  })

  it('永远只是"刚好够用"的子集，不会把缓存整片删空', () => {
    const entries = [entry('a', 5, 1), entry('b', 5, 2), entry('c', 5, 3)]

    expect(selectCacheEvictions(entries, 15, 8).map((one) => one.id)).toEqual(['a', 'b'])
  })
})

describe('shouldCacheEntry', () => {
  it('一份本身就超过上限的不缓存（否则它会先把缓存清空、再删自己）', () => {
    expect(shouldCacheEntry(100, 50)).toBe(false)
    expect(shouldCacheEntry(50, 50)).toBe(true)
    expect(shouldCacheEntry(49, 50)).toBe(true)
  })

  it('不知道长度（0）或不限制（<= 0）时都缓存 —— 前者由写完之后按实际大小兜一次', () => {
    expect(shouldCacheEntry(0, 50)).toBe(true)
    expect(shouldCacheEntry(Number.NaN, 50)).toBe(true)
    expect(shouldCacheEntry(100, 0)).toBe(true)
    expect(shouldCacheEntry(100, -1)).toBe(true)
    expect(shouldCacheEntry(100, Number.NaN)).toBe(true)
  })
})

describe('cacheSweepInterval', () => {
  it('上限越大间隔越大，且钳在 8–64 MiB', () => {
    const mib = 1024 * 1024

    expect(cacheSweepInterval(2 * 1024 * mib)).toBe(64 * mib) // 128 MiB → 钳到 64
    expect(cacheSweepInterval(200 * mib)).toBe(12.5 * mib) // 12.5 MiB 落在区间内
    expect(cacheSweepInterval(8 * mib)).toBe(8 * mib) // 512 KiB → 钳到 8
  })

  it('间隔不超过上限本身（上限 1 MiB 时不会先写进 8 MiB 才淘汰）', () => {
    expect(cacheSweepInterval(1024 * 1024)).toBe(1024 * 1024)
  })

  it('不限制时是 0（调用方按"永不扫描"处理）', () => {
    expect(cacheSweepInterval(0)).toBe(0)
    expect(cacheSweepInterval(-1)).toBe(0)
    expect(cacheSweepInterval(Number.NaN)).toBe(0)
  })
})

describe('cacheUsage / listCacheEntries', () => {
  beforeEach(resetDir)

  it('只算成对的条目：缺一半的残留不计入，不是我们的文件也不计入', async () => {
    write(BODY, 'body')
    write(META, 'meta')
    write(HALF_BODY, 'half')
    write('notes.txt', '别人的')

    expect(await cacheUsage()).toEqual({ entries: 1, bytes: 8 })
  })

  it('名字长得像条目的目录不是条目（只认普通文件）', async () => {
    mkdirSync(join(entryDir(), `${'a'.repeat(64)}.bin`))

    expect(await cacheUsage()).toEqual({ entries: 0, bytes: 0 })
  })

  it('跨账号与跨月份都算进来', async () => {
    write(BODY, 'abcd')
    write(META, 'ef')

    const other = join(accountDir(), '2026-09')
    mkdirSync(other, { recursive: true, mode: CACHE_DIR_MODE })
    writeFileSync(join(other, `${'d'.repeat(64)}.bin`), 'xyz')
    writeFileSync(join(other, `${'d'.repeat(64)}.meta.json`), '1')

    // 6（abcd + ef）+ 4（xyz + 1）
    expect(await cacheUsage()).toEqual({ entries: 2, bytes: 10 })
  })

  it('usedAt 取正文的 mtime；fileBytes 读不到时按 0 算', async () => {
    write(BODY, 'abcd')
    write(META, 'ef')

    const entries = await listCacheEntries()
    const bodyPath = join(entryDir(), BODY)

    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe('a'.repeat(64))
    expect(entries[0]?.bytes).toBe(6)
    expect(entries[0]?.usedAt).toBe(statSync(bodyPath).mtimeMs)

    expect(fileBytes(bodyPath)).toBe(4)
    expect(fileBytes(join(entryDir(), '没有这个文件.bin'))).toBe(0)
  })
})

describe('evictCacheToFit', () => {
  beforeEach(resetDir)

  it('删掉最久未用的成对条目：正文与元信息一起消失', async () => {
    const staleId = 'a'.repeat(64)
    const freshId = 'b'.repeat(64)

    write(`${staleId}.bin`, 'old')
    write(`${staleId}.meta.json`, 'm1')
    write(`${freshId}.bin`, 'new')
    write(`${freshId}.meta.json`, 'm2')

    // LRU 的输入就是正文的 mtime：把"旧"的那条往回拨一小时。
    const past = new Date(Date.now() - 3_600_000)
    utimesSync(join(entryDir(), `${staleId}.bin`), past, past)

    // 总计 10 字节、上限 5：删掉 5 字节的旧条目正好达标（新条目留下）。
    expect(await evictCacheToFit(5)).toEqual({ entries: 1, bytes: 5 })
    expect(names()).toEqual([`${freshId}.bin`, `${freshId}.meta.json`])
  })

  it('不认识的扩展名与缺一半的残留一个都不动', async () => {
    write(BODY, 'body')
    write(META, 'meta')
    write(HALF_BODY, 'half')
    write('notes.txt', '别人的')

    const result = await evictCacheToFit(1)

    // 只有成对的那一个是条目：它被删掉了，另外两个原封不动（上限没达成也认）。
    expect(result.entries).toBe(1)
    expect(names()).toEqual([HALF_BODY, 'notes.txt'].sort())
  })

  it('上限 <= 0 / 不合法时什么都不做（"不限制"是唯一安全的解释）', async () => {
    write(BODY, 'body')
    write(META, 'meta')

    expect(await evictCacheToFit(0)).toEqual({ entries: 0, bytes: 0 })
    expect(await evictCacheToFit(-1)).toEqual({ entries: 0, bytes: 0 })
    expect(await evictCacheToFit(Number.NaN)).toEqual({ entries: 0, bytes: 0 })

    expect(names()).toEqual([BODY, META].sort())
  })

  it('enforceCacheLimit 永不抛错：缓存根被别的东西占住时也只是"什么都没做"', async () => {
    rmSync(dir(), { recursive: true, force: true })
    writeFileSync(dir(), '不是一个目录')

    await expect(enforceCacheLimit(1)).resolves.toBe(0)
  })
})

describe('touchCacheEntry', () => {
  beforeEach(resetDir)

  it('把正文的 mtime 推到"现在"（LRU 唯一的时间戳）', () => {
    write(BODY, 'body')

    const bodyPath = join(entryDir(), BODY)
    const past = new Date(Date.now() - 3_600_000)
    utimesSync(bodyPath, past, past)

    touchCacheEntry(bodyPath)

    expect(statSync(bodyPath).mtimeMs).toBeGreaterThan(past.getTime() + 60_000)
  })

  it('文件不在时不抛错（留痕失败最坏只是这一条先被淘汰）', () => {
    expect(() => {
      touchCacheEntry(join(entryDir(), '没有这个文件.bin'))
    }).not.toThrow()
  })
})
