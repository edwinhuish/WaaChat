/**
 * 文件名净化的单测。
 *
 * 这些用例不是"补覆盖率"——每一条都对应一个具体的坏结果：路径穿越、扩展到错误的
 * 应用、归档内部条目被覆盖。改动 `naming.ts` 时这些断言必须仍然成立。
 */

import { describe, expect, it } from 'vitest'

import {
  FALLBACK_NAME,
  archiveNameCandidates,
  numberedName,
  pickExportName,
  sanitizeFileName,
} from '../../src/main/archive/naming'

describe('sanitizeFileName', () => {
  it('剥掉路径，只留最后一段', () => {
    expect(sanitizeFileName('../../../../etc/passwd')).toBe('passwd')
    expect(sanitizeFileName('/home/edwin/.bashrc')).toBe('bashrc')
    expect(sanitizeFileName('sub/dir/报告.pdf')).toBe('报告.pdf')
  })

  it('把 Windows 风格的分隔符也当路径处理', () => {
    expect(sanitizeFileName(String.raw`C:\Users\edwin\Desktop\invoice.pdf`)).toBe('invoice.pdf')
    expect(sanitizeFileName('a\\b/c.txt')).toBe('c.txt')
  })

  it('去掉控制字符', () => {
    expect(sanitizeFileName('evil\u0000name\u001b.pdf')).toBe('evilname.pdf')
    expect(sanitizeFileName('tab\tinside.txt')).toBe('tabinside.txt')
  })

  it('不留下以点开头的名字', () => {
    // 归档内部用 `.part-*` / `.open` 表示自己的东西，与它们同名会互相覆盖。
    expect(sanitizeFileName('.part-123')).toBe('part-123')
    expect(sanitizeFileName('.hidden')).toBe('hidden')
    expect(sanitizeFileName('...')).toBe(FALLBACK_NAME)
  })

  it('空输入回落到兜底名', () => {
    expect(sanitizeFileName('')).toBe(FALLBACK_NAME)
    expect(sanitizeFileName('   ')).toBe(FALLBACK_NAME)
    expect(sanitizeFileName('/')).toBe(FALLBACK_NAME)
  })

  it('超长名字截断但保留扩展名', () => {
    // 截断把 `.pdf` 砍掉的话，MIME 推断就没了，症状是"文件打不开"。
    const long = `${'あ'.repeat(300)}.pdf`
    const result = sanitizeFileName(long)

    expect(result.length).toBe(180)
    expect(result.endsWith('.pdf')).toBe(true)
  })

  it('没有扩展名的超长名字直接截断', () => {
    const result = sanitizeFileName('x'.repeat(400))

    expect(result.length).toBe(180)
    expect(result).toBe('x'.repeat(180))
  })

  it('中文与空格原样保留', () => {
    // 不做 Unicode 归一化是刻意的：归一化会让"用户看到的文件名"与保存的名字不一致。
    expect(sanitizeFileName('2026年第三季度 采购合同.pdf')).toBe('2026年第三季度 采购合同.pdf')
  })

  it('幂等：净化过的名字再净化一次不变', () => {
    const once = sanitizeFileName('../../a/b/合同 final.pdf')
    expect(sanitizeFileName(once)).toBe(once)
  })
})

describe('archiveNameCandidates', () => {
  const hash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2'

  it('第一个候选就是净化后的原名', () => {
    expect(archiveNameCandidates('2026年第三季度 采购合同.pdf', hash)[0]).toBe(
      '2026年第三季度 采购合同.pdf',
    )
    // 不可信输入先过 sanitize —— 落盘的名字始终是净化过的。
    expect(archiveNameCandidates('../../etc/passwd', hash)[0]).toBe('passwd')
    expect(archiveNameCandidates('', hash)[0]).toBe(FALLBACK_NAME)
  })

  it('冲突候选把哈希插在扩展名之前', () => {
    const candidates = archiveNameCandidates('报告.pdf', hash)

    expect(candidates[1]).toBe('报告 (a1b2c3d4).pdf')
    expect(candidates[2]).toBe('报告 (a1b2c3d4e5f6a7b8).pdf')
    expect(candidates[3]).toBe(`报告 (${hash}).pdf`)
  })

  it('每个候选都保留扩展名', () => {
    // 扩展名必须留在最后一段：去掉它，系统就推断不出 MIME，症状是"没有可用于打开该文件的应用"。
    for (const candidate of archiveNameCandidates('合同.pdf', hash)) {
      expect(candidate.endsWith('.pdf')).toBe(true)
    }

    // 没有扩展名时后缀直接接在末尾。
    expect(archiveNameCandidates('README', hash)[1]).toBe('README (a1b2c3d4)')
  })

  it('候选名不超长度上限（加上后缀也不能超）', () => {
    const candidates = archiveNameCandidates(`${'あ'.repeat(300)}.pdf`, hash)

    for (const candidate of candidates) {
      expect(candidate.length).toBeLessThanOrEqual(180)
    }
  })
})

/**
 * 导出的重名处理（[ADR-0050]）。
 *
 * 与归档那套哈希后缀是**两套规则**：归档的名字要进索引，必须确定性；导出目录里没有索引，
 * 名字是一次性的，而 ` (1)` 是用户在文件管理器里熟悉的形态。
 */
describe('numberedName / pickExportName', () => {
  const hash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2'

  it('序号插在扩展名之前（扩展名留在最后一段）', () => {
    expect(numberedName('报告.pdf', 1)).toBe('报告 (1).pdf')
    expect(numberedName('报告.pdf', 12)).toBe('报告 (12).pdf')
    // 没有扩展名时后缀直接接在末尾。
    expect(numberedName('README', 3)).toBe('README (3)')
  })

  it('名字没被占用时就用原名', () => {
    expect(pickExportName(new Set(), '报告.pdf', hash)).toBe('报告.pdf')
    expect(pickExportName(new Set(['别的.pdf']), '报告.pdf', hash)).toBe('报告.pdf')
  })

  it('被占用时依次尝试 (1)、(2)…', () => {
    const taken = new Set(['报告.pdf', '报告 (1).pdf', '报告 (2).pdf'])

    expect(pickExportName(taken, '报告.pdf', hash)).toBe('报告 (3).pdf')
  })

  it('挑名字之前先净化 —— 导出名不能带路径', () => {
    expect(pickExportName(new Set(), '../../etc/passwd', hash)).toBe('passwd')
    expect(pickExportName(new Set(), '', hash)).toBe(FALLBACK_NAME)
  })

  it('序号用完时退回归档那套哈希后缀（确定性，且仍然不覆盖）', () => {
    const taken = new Set(['报告.pdf'])
    for (let index = 1; index <= 999; index += 1) taken.add(numberedName('报告.pdf', index))

    // 999 个序号都被占了：接下来是哈希前缀，而不是硬写一个可能覆盖别人的名字。
    expect(pickExportName(taken, '报告.pdf', hash)).toBe('报告 (a1b2c3d4).pdf')
  })

  it('连哈希候选都被占时返回 null（调用方逐条报"挑不出名字"）', () => {
    const taken = new Set(['报告.pdf'])
    for (let index = 1; index <= 999; index += 1) taken.add(numberedName('报告.pdf', index))
    for (const candidate of archiveNameCandidates('报告.pdf', hash)) taken.add(candidate)

    expect(pickExportName(taken, '报告.pdf', hash)).toBeNull()
  })

  it('同名不同内容不会互相覆盖：第一个拿到原名，第二个拿到序号', () => {
    const taken = new Set<string>()

    expect(pickExportName(taken, '报告.pdf', hash)).toBe('报告.pdf')

    taken.add('报告.pdf')

    expect(pickExportName(taken, '报告.pdf', 'f'.repeat(64))).toBe('报告 (1).pdf')
  })

  it('超长名字加序号后仍不超长度上限', () => {
    const long = `${'あ'.repeat(300)}.pdf`

    expect(numberedName(sanitizeFileName(long), 1).length).toBeLessThanOrEqual(180)
  })
})
