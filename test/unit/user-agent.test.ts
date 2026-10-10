/**
 * User-Agent 构造的单测。
 *
 * 为什么这件事值得测：它一旦带上 `Electron/x.y.z`，上游就可能把整个客户端判定为
 * 不受支持的浏览器 —— 而症状是"页面能打开但功能缺失"，很难归因到这里。
 *
 * ⚠️ 这里原本写着"UA 是**唯一**能在不注入页面的前提下影响上游兼容性判断的手段（INV-1）"。
 * [ADR-0043](../../docs/decisions.md#adr-0043) 撤销 INV-1 之后那句话不再成立：现行路线允许
 * 注入与 CDP 驱动，"唯一"这个限定已失效。UA 本身仍需要干净 —— 只是理由收窄成"窗口仍然加载
 * 上游页面"这一点。
 */

import { describe, expect, it } from 'vitest'

import { buildUserAgent, isCleanUserAgent } from '../../src/shared/user-agent'

describe('buildUserAgent', () => {
  it('把 Chromium 版本填进桌面 Chrome 模板', () => {
    const ua = buildUserAgent('150.0.7871.129')

    expect(ua).toContain('Chrome/150.0.7871.129')
    expect(ua).toContain('X11; Linux x86_64')
  })

  it('不包含嵌入式运行时标记', () => {
    const ua = buildUserAgent('150.0.7871.129')

    expect(isCleanUserAgent(ua)).toBe(true)
    expect(ua).not.toContain('Electron')
    expect(ua).not.toContain('waachat')
  })

  it('拒绝不完整的版本号', () => {
    // 手写一个固定版本会与实际浏览器能力不符，而能力探测正是上游判定支持的依据。
    expect(() => buildUserAgent('150.0')).toThrow()
    expect(() => buildUserAgent('150')).toThrow()
    expect(() => buildUserAgent('')).toThrow()
    expect(() => buildUserAgent('150.0.7871.129-rc1')).toThrow()
  })
})

describe('isCleanUserAgent', () => {
  it('识别出带运行时标记的 UA', () => {
    expect(isCleanUserAgent('Mozilla/5.0 Electron/44.0.0 Chrome/150.0.0.0')).toBe(false)
    expect(isCleanUserAgent('Mozilla/5.0 WaaChat/1.0.0')).toBe(false)
  })

  it('干净 UA 返回 true', () => {
    expect(isCleanUserAgent('Mozilla/5.0 (X11; Linux x86_64) Chrome/150.0.0.0 Safari/537.36')).toBe(
      true,
    )
  })
})
