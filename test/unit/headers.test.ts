/**
 * 缓存回放响应头白名单的单测。
 *
 * 这些用例不是"补覆盖率"——每一条都对应一个具体的坏结果，而且症状**只在缓存命中时**
 * 出现、页面局部坏掉而不报错。理由与实测数据见 `docs/decisions.md` ADR-0016。
 */

import { describe, expect, it } from 'vitest'

import { CARRIED_HEADERS, carriedHeaders } from '../../src/main/capture/headers'

describe('carriedHeaders', () => {
  it('保留决定"这份响应怎么被处置"的头', () => {
    // 实测缺 `cross-origin-embedder-policy` 时，`web.whatsapp.com` 里的文档预览
    // 这个被嵌子文档会被判为不可嵌入，页面回 ERR_BLOCKED_BY_RESPONSE。
    const picked = carriedHeaders(
      new Headers({
        'content-type': 'application/octet-stream',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-resource-policy': 'cross-origin',
        'content-security-policy': 'frame-src https://webtp.whatsapp.net',
      }),
    )

    expect(picked['cross-origin-embedder-policy']).toBe('require-corp')
    expect(picked['cross-origin-opener-policy']).toBe('same-origin')
    expect(picked['cross-origin-resource-policy']).toBe('cross-origin')
    expect(picked['content-security-policy']).toBe('frame-src https://webtp.whatsapp.net')
  })

  it('不回放凭据类头（cache/ 承诺只放密文）', () => {
    const picked = carriedHeaders(
      new Headers({ 'content-type': 'text/html', 'set-cookie': 'session=secret' }),
    )

    expect('set-cookie' in picked).toBe(false)
  })

  it('不回放逐次变化的头', () => {
    const picked = carriedHeaders(
      new Headers({
        'content-type': 'text/html',
        date: 'Thu, 01 Jan 1970 00:00:00 GMT',
        'x-fb-debug': 'whatever',
      }),
    )

    expect('date' in picked).toBe(false)
    expect('x-fb-debug' in picked).toBe(false)
  })

  it('绝不回放 content-encoding（正文已是解码后的字节）', () => {
    // 带上它会让浏览器对已经解压过的正文再解一次 —— 页面拿到的是乱码。
    const picked = carriedHeaders(
      new Headers({ 'content-type': 'application/octet-stream', 'content-encoding': 'br' }),
    )

    expect('content-encoding' in picked).toBe(false)
    expect(CARRIED_HEADERS).not.toContain('content-encoding')
  })

  it('只挑白名单里的头，其余一律丢掉', () => {
    const picked = carriedHeaders(
      new Headers({ 'content-type': 'text/html', 'x-custom-upstream-header': 'v' }),
    )

    expect(Object.keys(picked)).toEqual(['content-type'])
  })

  it('白名单里每条都必须能真的被取出来', () => {
    // 防止把头的名字写错（例如写成 `cross-origin-embedder-policy ` 带空格）：
    // 那样的条目永远不会命中，而症状与"没写进去"完全一样。
    const all = carriedHeaders(new Headers(CARRIED_HEADERS.map((name) => [name, 'v'])))

    for (const name of CARRIED_HEADERS) {
      expect(all[name]).toBeDefined()
    }
  })
})
