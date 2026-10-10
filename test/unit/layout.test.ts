/**
 * 归档时间分区（[ADR-0037]）的单测。
 *
 * 这一层是**纯函数**，所以每条断言都直接对应一个具体的坏结果：
 *
 *   1. **年月算错**（拿 UTC 当本地时间、忘了月份从 0 开始）→ 文件落进相邻月份目录，
 *      用户不会发现，但"按时间翻文件夹"从此不可信；
 *   2. **相对路径不净化** → `join(归档目录, stored_name)` 变成路径穿越点；
 *   3. **年月判据放太宽**（`26` / `13` / `1` 都认）→ 迁移会把用户自己的目录当成正文容器，
 *      或者反过来把自己的目录当成"这里被别的东西用了"而拒绝迁移。
 */

import { describe, expect, it } from 'vitest'

import {
  archiveRelativePath,
  folderFor,
  isArchiveMonth,
  isArchiveYear,
  normalizeStoredPath,
} from '../../src/main/archive/layout'

describe('folderFor', () => {
  it('按本地时间给出 年/月', () => {
    // 本地时间正午，避开时区与夏令时把日期推过边界的可能。
    expect(folderFor(new Date(2026, 9, 5, 12).getTime())).toBe('2026/10')
  })

  it('月份从 1 开始算，而不是 Date 的 0', () => {
    expect(folderFor(new Date(2026, 0, 31, 12).getTime())).toBe('2026/01')
    expect(folderFor(new Date(2026, 11, 31, 12).getTime())).toBe('2026/12')
  })

  it('个位月份补零（否则目录名的字典序与时间序不一致）', () => {
    expect(folderFor(new Date(2026, 2, 1, 12).getTime())).toBe('2026/03')
  })

  it('用的是本地时间：同一时刻在不同时区可以落在不同月份，但那正是"用户手表上的日期"', () => {
    // 这里只锁"不会因为时区把月推错"的判据：正午的时刻，任何常见时区都在同一天。
    const noon = new Date(2026, 9, 15, 12).getTime()
    expect(folderFor(noon)).toBe('2026/10')
  })

  it('非有限时间戳直接抛（否则会建出一个 NaN/NaN 目录）', () => {
    expect(() => folderFor(Number.NaN)).toThrow(TypeError)
    expect(() => folderFor(Number.POSITIVE_INFINITY)).toThrow(TypeError)
  })
})

describe('年月目录判据', () => {
  it('年份必须是四位数字', () => {
    expect(isArchiveYear('2026')).toBe(true)
    expect(isArchiveYear('26')).toBe(false)
    expect(isArchiveYear('20261')).toBe(false)
    expect(isArchiveYear('202a')).toBe(false)
    expect(isArchiveYear('')).toBe(false)
  })

  it('月份必须是 01–12', () => {
    expect(isArchiveMonth('01')).toBe(true)
    expect(isArchiveMonth('10')).toBe(true)
    expect(isArchiveMonth('12')).toBe(true)
    expect(isArchiveMonth('00')).toBe(false)
    expect(isArchiveMonth('13')).toBe(false)
    // `1` 不认：`folderFor()` 从不产出它，认了就等于允许两棵并存的目录树。
    expect(isArchiveMonth('1')).toBe(false)
    expect(isArchiveMonth('')).toBe(false)
  })

  it('两级判据能拼出 folderFor 的产物（判据与布局不会各自漂移）', () => {
    const [year, month] = folderFor(new Date(2026, 9, 5, 12).getTime()).split('/')

    expect(isArchiveYear(year ?? '')).toBe(true)
    expect(isArchiveMonth(month ?? '')).toBe(true)
  })
})

describe('archiveRelativePath', () => {
  it('把年月目录与文件名拼成写进索引的相对路径', () => {
    expect(archiveRelativePath('2026/10', '合同.pdf')).toBe('2026/10/合同.pdf')
  })

  it('没有年月目录时就是文件名（旧布局）', () => {
    expect(archiveRelativePath('', '合同.pdf')).toBe('合同.pdf')
  })
})

describe('normalizeStoredPath', () => {
  it('剥掉路径穿越（`..` 与多余的分隔符都不会越出归档目录）', () => {
    expect(normalizeStoredPath('../../etc/passwd')).toBe('etc/passwd')
    expect(normalizeStoredPath('/etc/passwd')).toBe('etc/passwd')
    expect(normalizeStoredPath('2026/../../etc/passwd')).toBe('2026/etc/passwd')
  })

  it('去掉空段与 `.`（用户手改索引后的容错）', () => {
    expect(normalizeStoredPath('2026//10/报告.pdf')).toBe('2026/10/报告.pdf')
    expect(normalizeStoredPath('./2026/10/报告.pdf')).toBe('2026/10/报告.pdf')
  })

  it('什么都剩不下时返回空串（调用方据此选用一个不可能存在的路径）', () => {
    expect(normalizeStoredPath('')).toBe('')
    expect(normalizeStoredPath('..')).toBe('')
    expect(normalizeStoredPath('../')).toBe('')
  })

  it('正常的两种形态原样保留', () => {
    expect(normalizeStoredPath('2026/10/2026年第三季度采购合同.pdf')).toBe(
      '2026/10/2026年第三季度采购合同.pdf',
    )
    expect(normalizeStoredPath('a1b2c3d4.pdf')).toBe('a1b2c3d4.pdf')
  })
})
