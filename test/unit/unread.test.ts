/**
 * 未读计数判据的单测（`src/shared/unread.ts`）。
 *
 * 为什么值得测：这一项**只有**一个数据源（页面标题），而它出错的方式全是安静的 ——
 *
 *   - 把"读不到"当成 0：徽标不出现，而我们以为自己知道"没有未读"（那是两件不同的事）；
 *   - 认错格式：徽标显示一个错的数字（`(abc) WhatsApp` 被读成某个数）；
 *   - 上限没做：三位数在托盘图标上（约 22px）糊成一团，等于没有徽标。
 *
 * 上游一改标题格式，这里不会有任何症状 —— 因此判据本身必须是"宁可不知道，也不猜"。
 */

import { describe, expect, it } from 'vitest'

import {
  UNREAD_BADGE_LIMIT,
  formatWindowTitle,
  parseUnreadCount,
  unreadBadgeLabel,
} from '../../src/shared/unread'

describe('parseUnreadCount', () => {
  it('认出前缀里的条数（上游写的是 "(3) WhatsApp"）', () => {
    expect(parseUnreadCount('(3) WhatsApp')).toBe(3)
    expect(parseUnreadCount('(12) WhatsApp')).toBe(12)
    expect(parseUnreadCount('(999) WhatsApp')).toBe(999)
  })

  it('前缀前允许有空白（上游偶尔先放一个空格）', () => {
    expect(parseUnreadCount(' (7) WhatsApp')).toBe(7)
  })

  it('读不到就是 null —— 包括"上游说了没有未读"（(0)）', () => {
    // 两者的区别在类型上（null / 数字），但对调用方来说要做的都是"不画徽标"。
    for (const title of [
      'WhatsApp',
      '(0) WhatsApp',
      '',
      '(abc) WhatsApp',
      '(1 WhatsApp',
      'WhatsApp (3)',
      '(-2) WhatsApp',
      '(1.5) WhatsApp',
      '(12345) WhatsApp',
    ]) {
      expect(parseUnreadCount(title)).toBeNull()
    }
  })

  it('不把别的东西里的括号当未读数（前后缀的位置是判据的一部分）', () => {
    expect(parseUnreadCount('Chat with (3) friends')).toBeNull()
    expect(parseUnreadCount('WhatsApp (3)')).toBeNull()
  })
})

describe('unreadBadgeLabel', () => {
  it('没有未读就不画（null / 0 / 负数都一样）', () => {
    expect(unreadBadgeLabel(null)).toBeNull()
    expect(unreadBadgeLabel(0)).toBeNull()
    expect(unreadBadgeLabel(-3)).toBeNull()
  })

  it('一位数与两位数原样显示', () => {
    expect(unreadBadgeLabel(1)).toBe('1')
    expect(unreadBadgeLabel(9)).toBe('9')
    expect(unreadBadgeLabel(10)).toBe('10')
    expect(unreadBadgeLabel(UNREAD_BADGE_LIMIT)).toBe('99')
  })

  it('超过上限收成 99+（徽标只有三格宽，三位数放不下）', () => {
    expect(unreadBadgeLabel(UNREAD_BADGE_LIMIT + 1)).toBe('99+')
    expect(unreadBadgeLabel(4321)).toBe('99+')
  })
})

describe('formatWindowTitle', () => {
  it('没有未读时标题就是应用名（命名实例因此仍然自报家门）', () => {
    expect(formatWindowTitle('WaaChat（工作）', null)).toBe('WaaChat（工作）')
    expect(formatWindowTitle('WaaChat', 0)).toBe('WaaChat')
  })

  it('有未读时在后面接一句（窗口列表 / 任务栏里能看到的就是它）', () => {
    expect(formatWindowTitle('WaaChat', 3)).toBe('WaaChat — 3 条未读')
    expect(formatWindowTitle('WaaChat（工作）', 120)).toBe('WaaChat（工作） — 99+ 条未读')
  })
})
