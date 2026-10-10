/**
 * 设置窗口的区域与行序（`shared/settings-sections.ts`）。
 *
 * 这些是**约定**，不是样式细节，因此值得被断言：
 *
 *   1. **每个设置项恰好出现一次** —— 漏掉一个等于它在界面上消失，没人会发现
 *      （编译期断言 `ALL_SETTINGS_RENDERED` 管住"漏"，这里管住"重复"与"运行时也对得上"）；
 *   2. **容量项与它管辖的那个开关在同一个区域里** —— 一个容量项离开开关就读不懂
 *      （"2 GB"是给谁设的上限？），而这条正是用户提过的诉求；
 *   3. **区域标题不能是空的、区域不能是空的** —— 空标题等于一个没有名字的区域。
 */

import { describe, expect, it } from 'vitest'

import {
  ALL_SETTINGS_RENDERED,
  SETTINGS_ROW_ORDER,
  SETTINGS_SECTIONS,
  sectionOfRow,
  type SettingsRowKey,
} from '../../src/shared/settings-sections'
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/types'

/** 界面上应当出现的全部行：每个设置项 + 应用图标那一行。 */
const ALL_ROWS: readonly SettingsRowKey[] = [
  ...(Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]),
  'appIcon',
]

describe('SETTINGS_SECTIONS', () => {
  it('每个设置项恰好出现一行（不重不漏）', () => {
    expect([...SETTINGS_ROW_ORDER].sort()).toEqual([...ALL_ROWS].sort())
    expect(new Set(SETTINGS_ROW_ORDER).size).toBe(SETTINGS_ROW_ORDER.length)
  })

  it('编译期那条断言与运行时的事实一致', () => {
    expect(ALL_SETTINGS_RENDERED).toBe(true)
  })

  it('区域标题非空，且每个区域至少有一行', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.title.trim()).not.toBe('')
      expect(section.rows.length).toBeGreaterThan(0)
    }
  })

  it('扁平顺序就是区域依次展开（两处不会各自漂移）', () => {
    expect(SETTINGS_ROW_ORDER).toEqual(SETTINGS_SECTIONS.flatMap((s) => [...s.rows]))
  })

  it('每个设置项都能找到自己的区域', () => {
    for (const key of ALL_ROWS) {
      expect(sectionOfRow(key)).not.toBeNull()
    }
  })
})

describe('容量项与它们管辖的开关在同一个区域里', () => {
  it('密文缓存上限紧跟密文磁盘缓存（同一区域、紧邻其后）', () => {
    expect(sectionOfRow('cacheMaxBytes')).toBe(sectionOfRow('enableCiphertextCache'))

    const rows = sectionOfRow('enableCiphertextCache')?.rows ?? []
    expect(rows.indexOf('cacheMaxBytes')).toBe(rows.indexOf('enableCiphertextCache') + 1)
  })

  it('归档大小上限与文件保存位置在同一区域', () => {
    expect(sectionOfRow('archiveMaxBytes')).toBe(sectionOfRow('archiveDir'))
  })

  it('密文缓存区域里还有后台预取（它预取的就是密文，缓存关着时它没有意义）', () => {
    expect(sectionOfRow('prefetch')).toBe(sectionOfRow('enableCiphertextCache'))
  })
})
