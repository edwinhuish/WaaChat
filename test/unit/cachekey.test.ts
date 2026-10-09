/**
 * 缓存键推导的单测。
 *
 * 这是接管点 B 里最容易出错的一环，而它的两种失败后果不对称：
 *
 *   漏命中 → 又下载了一次（性能损失，用户几乎察觉不到）
 *   错命中 → 用户打开到一个**解不开的文件**（功能损坏）
 *
 * 因此断言的重点是后半边：**不该合并的东西绝不能合并**。
 */

import { describe, expect, it } from 'vitest'

import { deriveCacheKey, isMediaRequest, stableQuery } from '../../src/main/capture/cachekey'

describe('isMediaRequest', () => {
  it('只认媒体 CDN 的 https 请求', () => {
    expect(isMediaRequest('https://mmg.whatsapp.net/v/t62.7118-24/abc')).toBe(true)
    expect(isMediaRequest('https://media-cdg4-1.cdn.whatsapp.net/v/t62/abc')).toBe(true)
  })

  it('按 CDN 后缀匹配，容忍区域与编号变化', () => {
    // 上游会在多个 CDN 域之间切换（实测同时出现 media-hkg1-1 / hkg4-2），
    // 因此判据是后缀而不是 host 全名。
    expect(isMediaRequest('https://media-hkg1-1.cdn.whatsapp.net/v/t62/abc')).toBe(true)
    expect(isMediaRequest('https://media-hkg4-2.cdn.whatsapp.net/v/t62/abc')).toBe(true)
  })

  it('拒绝网页域', () => {
    expect(isMediaRequest('https://web.whatsapp.com/')).toBe(false)
    expect(isMediaRequest('https://www.whatsapp.com/')).toBe(false)
  })

  it('拒绝同一个域里托管网页资源的子域', () => {
    // 曾经这里断言的是 `true`：整个 `whatsapp.net` 都被当成媒体 CDN，于是静态资源
    // 与文档预览页也被写进密文缓存（实测 161 条里 98 条是这类明文资源）。
    // 收窄的理由与证据见 ADR-0015 —— 改动这条断言时请连着那条 ADR 一起读。
    expect(isMediaRequest('https://static.whatsapp.net/rsrc.php/x.js')).toBe(false)
    expect(isMediaRequest('https://webtp.whatsapp.net/pdf-viewer/?locale=zh_CN')).toBe(false)
    expect(isMediaRequest('https://flows.whatsapp.net/flows/cache_management/')).toBe(false)
  })

  it('拒绝后缀相近但不是同一域的 host', () => {
    // `endsWith('.whatsapp.net')` 而不是 `includes('whatsapp.net')` 就是为了这个。
    expect(isMediaRequest('https://evilwhatsapp.net/x')).toBe(false)
    expect(isMediaRequest('https://whatsapp.net.evil.com/x')).toBe(false)
  })

  it('拒绝 http 与畸形 URL', () => {
    expect(isMediaRequest('http://mmg.whatsapp.net/x')).toBe(false)
    expect(isMediaRequest('not a url')).toBe(false)
    expect(isMediaRequest('')).toBe(false)
  })
})

describe('stableQuery', () => {
  it('剔除签名与有效期类参数', () => {
    // 含进去会导致缓存永不命中（每次请求的参数都不同）。
    const url = new URL(
      'https://mmg.whatsapp.net/x?oh=deadbeef&oe=68f1&ccb=10-15&_nc_hot=1&keep=yes',
    )

    expect(stableQuery(url)).toBe('keep=yes')
  })

  it('参数顺序不影响结果', () => {
    // 顺序不稳定会让同一个对象产生多个键，表现为"缓存时好时坏"——最难查的一类间歇故障。
    const a = new URL('https://mmg.whatsapp.net/x?b=2&a=1')
    const b = new URL('https://mmg.whatsapp.net/x?a=1&b=2')

    expect(stableQuery(a)).toBe(stableQuery(b))
  })

  it('不认识的参数一律保留', () => {
    // 宁可漏命中，不可错命中。
    const url = new URL('https://mmg.whatsapp.net/x?mystery=42')
    expect(stableQuery(url)).toBe('mystery=42')
  })
})

describe('deriveCacheKey', () => {
  it('去掉易变参数后得到稳定键', () => {
    const url = 'https://mmg.whatsapp.net/v/t62.7118-24/abc?oh=111&oe=222&ccb=10-15'

    expect(deriveCacheKey(url)).toBe('mmg.whatsapp.net/v/t62.7118-24/abc')
  })

  it('签名变化时键不变（同一份内容的两次请求）', () => {
    const first = 'https://mmg.whatsapp.net/v/t62/abc?oh=AAA&oe=1'
    const second = 'https://mmg.whatsapp.net/v/t62/abc?oh=BBB&oe=2'

    expect(deriveCacheKey(first)).toBe(deriveCacheKey(second))
  })

  it('不同路径得到不同的键', () => {
    const first = 'https://mmg.whatsapp.net/v/t62/abc'
    const second = 'https://mmg.whatsapp.net/v/t62/xyz'

    expect(deriveCacheKey(first)).not.toBe(deriveCacheKey(second))
  })

  it('host 大小写不影响键', () => {
    expect(deriveCacheKey('https://MMG.WhatsApp.NET/v/t62/abc')).toBe(
      deriveCacheKey('https://mmg.whatsapp.net/v/t62/abc'),
    )
  })

  it('非媒体请求返回 null（表示"不走缓存"）', () => {
    expect(deriveCacheKey('https://web.whatsapp.com/')).toBeNull()
    expect(deriveCacheKey('broken')).toBeNull()
  })
})
