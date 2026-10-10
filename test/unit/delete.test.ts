/**
 * 批量删除的单测（[ADR-0053]）。
 *
 * 这是唯一一个**会删掉用户数据**的动作，因此每一条断言都对应一个具体的坏结果：
 * 删了用户没选的（同内容的别的名字）、留下"搜得到但打不开"的悬空记录、或者留下一份
 * "没有索引指向的正文"（既不会被淘汰、也不会再被看见），以及一条失败把整批停下。
 *
 * 依赖以回调注入，因此不需要文件系统也不需要 sqlite —— 断言的是那条**配对规则**。
 * 真实文件系统上的一半在 `blobs.test.ts` 的 `removeStoredFile` 里。
 */

import { describe, expect, it } from 'vitest'

import { DELETE_MAX_ITEMS, deleteRecords } from '../../src/main/archive/delete'
import { describeDeleteResult } from '../../src/shared/deletion'
import type { ArchiveRecord } from '../../src/shared/types'

function record(id: number, name: string, storedName: string): ArchiveRecord {
  return {
    id,
    hash: 'a'.repeat(64),
    name,
    storedName,
    bytes: 1,
    mime: 'application/pdf',
    openedAt: 1_700_000_000_000,
  }
}

interface Fake {
  readonly removed: string[]
  readonly forgotten: number[]
  readonly pruned: string[]
  readonly removeFile: (storedName: string) => boolean
  readonly forget: (id: number) => boolean
  readonly prune: (storedName: string) => void
}

/**
 * 假的"文件系统 + 索引 + 空容器清理"。
 *
 * `undeletable` 模拟"名字在、但删不掉"（被占用、只读挂载）；`vanishedRecords` 模拟
 * "文件已经不在了、记录也没了"（被淘汰或另一次删除带走）。
 */
function fake(options: {
  undeletable?: readonly string[]
  vanishedRecords?: readonly number[]
}): Fake {
  const undeletable = new Set(options.undeletable ?? [])
  const vanished = new Set(options.vanishedRecords ?? [])
  const removed: string[] = []
  const forgotten: number[] = []
  const pruned: string[] = []

  return {
    removed,
    forgotten,
    pruned,
    removeFile: (storedName) => {
      removed.push(storedName)
      // 不在 undeletable 里的都成功（包括"本来就不在" —— 与 `removeStoredFile()` 的 ENOENT 一致）。
      return !undeletable.has(storedName)
    },
    forget: (id) => {
      forgotten.push(id)
      return !vanished.has(id)
    },
    prune: (storedName) => {
      pruned.push(storedName)
    },
  }
}

describe('deleteRecords', () => {
  it('逐条删掉：磁盘名与索引记录各清一次', () => {
    const disk = fake({})
    const records = [
      record(1, '甲.pdf', 'acc/m/files/甲.pdf'),
      record(2, '乙.pdf', 'acc/m/files/乙.pdf'),
    ]

    const summary = deleteRecords(records, disk.removeFile, disk.forget, disk.prune)

    expect(summary).toEqual({ deleted: 2, failed: [] })
    expect(disk.removed).toEqual(['acc/m/files/甲.pdf', 'acc/m/files/乙.pdf'])
    expect(disk.forgotten).toEqual([1, 2])
  })

  it('顺序是"删文件 → 清空容器 → 删记录"（[ADR-0054]）', () => {
    // 三步的失败含义各不相同，顺序错一步就会留下不一致的状态，因此把调用顺序钉住。
    const trace: string[] = []
    const records = [
      record(1, '甲.pdf', 'acc/m/files/甲.pdf'),
      record(2, '占用.pdf', 'acc/m/files/占用.pdf'),
    ]

    const summary = deleteRecords(
      records,
      (storedName) => {
        trace.push(`remove:${storedName}`)
        return !storedName.endsWith('占用.pdf')
      },
      (id) => {
        trace.push(`forget:${String(id)}`)
        return true
      },
      (storedName) => {
        trace.push(`prune:${storedName}`)
      },
    )

    expect(summary.deleted).toBe(1)
    expect(trace).toEqual([
      'remove:acc/m/files/甲.pdf',
      // 文件没了、容器可能空了 ⇒ 收在删记录**之前**，且不看记录删得成不成功。
      'prune:acc/m/files/甲.pdf',
      'forget:1',
      // 删不掉的那条到此为止：磁盘上那份还在，容器不空，索引也不该动。
      'remove:acc/m/files/占用.pdf',
    ])
  })

  it('文件删不掉时**不动**索引记录，也不去清空容器', () => {
    const disk = fake({ undeletable: ['acc/m/files/占用.pdf'] })
    const records = [record(1, '占用.pdf', 'acc/m/files/占用.pdf')]

    const summary = deleteRecords(records, disk.removeFile, disk.forget, disk.prune)

    expect(summary).toEqual({ deleted: 0, failed: [{ name: '占用.pdf', reason: 'remove-failed' }] })
    // 关键：记录必须留着。删掉它就成了"搜得到但打不开"，而磁盘上那份还活着。
    expect(disk.forgotten).toEqual([])
    // 同理：那一份还在目录里，那一层就不空 —— 去清它等于动用户没选的东西。
    expect(disk.pruned).toEqual([])
  })

  it('文件已经不在了但记录也没删掉时同样报失败（那是"别人干的"，不能记成我们删的）', () => {
    const disk = fake({ vanishedRecords: [1] })
    const records = [record(1, '甲.pdf', 'acc/m/files/甲.pdf')]

    const summary = deleteRecords(records, disk.removeFile, disk.forget, disk.prune)

    expect(summary.deleted).toBe(0)
    expect(summary.failed).toEqual([{ name: '甲.pdf', reason: 'remove-failed' }])
  })

  it('一条失败不影响后面的条目（一条被占用不该让另外两条也留下）', () => {
    const disk = fake({ undeletable: ['占用.pdf'] })
    const records = [
      record(1, '占用.pdf', '占用.pdf'),
      record(2, '甲.pdf', '甲.pdf'),
      record(3, '乙.pdf', '乙.pdf'),
    ]

    const summary = deleteRecords(records, disk.removeFile, disk.forget, disk.prune)

    expect(summary.deleted).toBe(2)
    expect(summary.failed).toEqual([{ name: '占用.pdf', reason: 'remove-failed' }])
    expect(disk.forgotten).toEqual([2, 3])
  })

  it('只碰传进来的那些名字 —— 同一份内容的另一个名字必须原样留着', () => {
    // 同一份内容出现在两条消息里（[ADR-0052] 的硬链接）：用户只选了第一条。
    const disk = fake({})
    const first = record(1, '合同.pdf', 'acc/msg-a/files/合同.pdf')

    const summary = deleteRecords([first], disk.removeFile, disk.forget, disk.prune)

    expect(summary.deleted).toBe(1)
    // 第二个名字一次都没被碰过 —— "顺手多删"就是删用户没选的数据。
    expect(disk.removed).toEqual(['acc/msg-a/files/合同.pdf'])
    expect(disk.removed).not.toContain('acc/msg-b/files/合同.pdf')
    // 清理也只看这一条的名字：`msg-b` 那一层是别人的，轮不到我们判断它空不空。
    expect(disk.pruned).toEqual(['acc/msg-a/files/合同.pdf'])
  })

  it('空清单什么都不做', () => {
    const disk = fake({})

    expect(deleteRecords([], disk.removeFile, disk.forget, disk.prune)).toEqual({
      deleted: 0,
      failed: [],
    })
    expect(disk.removed).toEqual([])
    expect(disk.pruned).toEqual([])
  })

  it('单次上限是防御性数字，不是对正常使用的限制', () => {
    // 列表窗口一页 100 条，因此这个数字应当明显大于一页（与导出同一个量级）。
    expect(DELETE_MAX_ITEMS).toBeGreaterThan(100)
  })
})

describe('describeDeleteResult', () => {
  it('全部成功时也说一声（用户点完"删除"需要一个确认）', () => {
    expect(describeDeleteResult({ deleted: 3, failed: [] })).toBe('已从归档删除 3 个文件。')
  })

  it('部分失败时成功数与失败数一起说', () => {
    const text = describeDeleteResult({
      deleted: 2,
      failed: [{ name: '占用.pdf', reason: 'remove-failed' }],
    })

    expect(text).toContain('已从归档删除 2 个文件')
    expect(text).toContain('1 个失败')
    expect(text).toContain('占用.pdf')
  })

  it('同一个原因合并成一句，超过三个名字用"等 N 个"收尾（200 条失败不该撑成一堵墙）', () => {
    const failed = ['甲.pdf', '乙.pdf', '丙.pdf', '丁.pdf', '戊.pdf'].map((name) => ({
      name,
      reason: 'remove-failed' as const,
    }))

    const text = describeDeleteResult({ deleted: 0, failed })

    expect(text.split('\n')).toHaveLength(2)
    expect(text).toContain('甲.pdf、乙.pdf、丙.pdf 等 5 个')
  })

  it('名字取不到的条目（记录本身已经没了）不假装知道它叫什么', () => {
    const text = describeDeleteResult({ deleted: 1, failed: [{ name: null, reason: 'missing' }] })

    expect(text).toContain('一条已不在归档里的记录')
  })
})
