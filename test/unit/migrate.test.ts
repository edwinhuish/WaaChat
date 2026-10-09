/**
 * 归档迁移的单测。
 *
 * 这一层最要命的失败不是"搬得慢"，而是**搬了一半**：一部分文件在新位置、一部分还在
 * 旧位置，而设置只认得其中一边。因此这里的重点全在"失败时会怎样"——
 * 回滚必须把已搬走的搬回来，而**搬不动的绝不能删**（那可能是用户唯一的副本）。
 */

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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  migrateArchive,
  planMigration,
  rollbackMigration,
  type MigrationPlan,
} from '../../src/main/archive/migrate'

const BLOB_A = 'a'.repeat(64)
const BLOB_B = 'b'.repeat(64)

let root: string
let source: string
let target: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'waachat-migrate-'))
  source = join(root, 'old')
  target = join(root, 'new')
  mkdirSync(source, { recursive: true, mode: 0o700 })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 一份"用过的归档目录"：两个正文、一个索引、一个硬链接目录、一个半成品。 */
function seedSource(): void {
  writeFileSync(join(source, BLOB_A), 'first')
  writeFileSync(join(source, BLOB_B), 'second')
  writeFileSync(join(source, '.index.sqlite'), 'database')
  mkdirSync(join(source, '.open'), { recursive: true })
  writeFileSync(join(source, '.open', 'somehash'), 'link')
  writeFileSync(join(source, '.part-leftover'), 'half written')
}

/** 产出计划；失败时直接抛出，让用例只关心成功路径。 */
function plan(): MigrationPlan {
  const outcome = planMigration(source, target)
  if (!outcome.ok) throw new Error(`计划失败：${outcome.failure} ${outcome.detail}`)
  return outcome.plan
}

describe('planMigration', () => {
  it('正文与索引进计划，派生物只算作"可删"', () => {
    seedSource()

    const planned = plan()

    expect([...planned.entries].sort()).toEqual([BLOB_A, BLOB_B, '.index.sqlite'].sort())
    expect([...planned.disposable].sort()).toEqual(['.open', '.part-leftover'].sort())
    expect(planned.summary).toEqual({ files: 2, bytes: 11 })
  })

  it('拒绝非空的目标目录：归档不做合并', () => {
    seedSource()
    mkdirSync(target)
    writeFileSync(join(target, 'something-else'), 'x')

    expect(planMigration(source, target)).toMatchObject({ ok: false, failure: 'target-not-empty' })
  })

  it('拒绝嵌套位置（否则复制会自我递归，或搬完等于没搬）', () => {
    seedSource()

    expect(planMigration(source, source)).toMatchObject({ failure: 'nested-location' })
    expect(planMigration(source, join(source, 'inner'))).toMatchObject({
      failure: 'nested-location',
    })
    expect(planMigration(source, root)).toMatchObject({ failure: 'nested-location' })
  })

  it('拒绝符号链接：不跟随，也不静默跳过', () => {
    // 跳过等于"迁移成功"而后文件少了一部分，那比迁移失败严重得多。
    symlinkSync(source, join(source, 'loop'))

    expect(planMigration(source, target)).toMatchObject({ failure: 'unexpected-content' })
  })

  it('拒绝不是目录的目标', () => {
    seedSource()
    writeFileSync(target, 'a file')

    expect(planMigration(source, target)).toMatchObject({ failure: 'not-a-directory' })
  })

  it('源目录不存在时报 source-missing', () => {
    expect(planMigration(join(root, 'nowhere'), target)).toMatchObject({
      failure: 'source-missing',
    })
  })
})

describe('migrateArchive', () => {
  it('把正文与索引搬到新位置，删掉派生物，并删掉变空的源目录', async () => {
    seedSource()

    const result = await migrateArchive(plan(), () => undefined)

    expect(result).toEqual({ ok: true })
    expect(readdirSync(target).sort()).toEqual([BLOB_A, BLOB_B, '.index.sqlite'].sort())

    // 派生物不搬：`.open/` 里的硬链接复制过去会指向新 inode（与正文脱钩），
    // 而它本来就能从正文重建；`.part-*` 是半成品，更没有搬的价值。
    expect(readdirSync(target)).not.toContain('.open')
    expect(readdirSync(target)).not.toContain('.part-leftover')

    expect(existsSync(source)).toBe(false)
  })

  it('报告进度：从 0 开始，逐个条目递增', async () => {
    seedSource()
    const seen: number[] = []

    await migrateArchive(plan(), (progress) => seen.push(progress.done))

    expect(seen[0]).toBe(0)
    expect(seen).toContain(3) // 2 个正文 + 1 个索引
  })

  it('中途失败时把已搬走的条目搬回原位', async () => {
    seedSource()

    const result = await migrateArchive(plan(), () => undefined, {
      afterEntry: (_name, index) => {
        // 第二个条目之后失败：此时第一个已经在新位置了 —— 正是回滚要处理的局面。
        if (index === 1) throw new Error('disk full')
      },
    })

    expect(result).toMatchObject({ ok: false, failure: 'write-failed', rolledBack: true })

    // 原位置必须一个不少（包括尚未搬走的派生物与索引）。
    expect(readdirSync(source).sort()).toEqual(
      [BLOB_A, BLOB_B, '.index.sqlite', '.open', '.part-leftover'].sort(),
    )
    expect(existsSync(join(target, BLOB_A))).toBe(false)
  })

  it('回滚只做搬运，不删除任何数据', async () => {
    seedSource()

    await migrateArchive(plan(), () => undefined, {
      afterEntry: (_name, index) => {
        if (index === 0) throw new Error('boom')
      },
    })

    expect(existsSync(join(source, BLOB_A))).toBe(true)
    expect(existsSync(join(source, BLOB_B))).toBe(true)
    expect(readFileSync(join(source, BLOB_A), 'utf8')).toBe('first')
  })

  it('没有可回滚的东西时，回滚是幂等的', async () => {
    seedSource()

    await expect(rollbackMigration(plan())).resolves.toBe(true)
    expect(existsSync(join(source, BLOB_A))).toBe(true)
  })
})

/**
 * 跨文件系统的那条分支（`rename` 抛 EXDEV）走的是另一段代码：复制 → 校验大小 → 改名。
 * 用 `/dev/shm`（通常与 `TMPDIR` 不是同一个设备）触发它；环境里没有独立 tmpfs 时
 * **跳过**，而不是让一个其实没走那条分支的用例假装通过。
 */
const SHM = '/dev/shm'
const crossDeviceFilesystem = existsSync(SHM) && statSync(SHM).dev !== statSync(tmpdir()).dev

describe.skipIf(!crossDeviceFilesystem)('migrateArchive（跨设备）', () => {
  it('退化为复制 + 大小校验，内容一致', async () => {
    seedSource()
    const crossTarget = mkdtempSync(join(SHM, 'waachat-migrate-'))

    try {
      const planned = planMigration(source, crossTarget)
      if (!planned.ok) throw new Error(`计划失败：${planned.failure}`)

      const result = await migrateArchive(planned.plan, () => undefined)

      expect(result).toEqual({ ok: true })
      expect(readFileSync(join(crossTarget, BLOB_A), 'utf8')).toBe('first')
      expect(readFileSync(join(crossTarget, BLOB_B), 'utf8')).toBe('second')
      expect(existsSync(source)).toBe(false)
    } finally {
      rmSync(crossTarget, { recursive: true, force: true })
    }
  })
})
