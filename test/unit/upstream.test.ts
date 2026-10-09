/**
 * "上游域"判据的单测。
 *
 * 这里防的是同一类事故：**前缀匹配**。`url.startsWith('https://web.whatsapp.com')`
 * 会同时放过下面两条：
 *
 *   https://web.whatsapp.com.evil.com/     —— 看起来像站内
 *   https://web.whatsapp.com@evil.com/     —— 真正的 host 是 evil.com
 *
 * 后者不只是"少开了一个浏览器窗口"：权限白名单用的是同一个判据，于是摄像头 /
 * 麦克风会被交给那个页面（docs/security.md T5）。
 */

import { describe, expect, it } from 'vitest'

import { isUpstreamOrigin, isUpstreamPage } from '../../src/shared/upstream'

describe('isUpstreamOrigin', () => {
  it('只认承载登录态的那一个源', () => {
    expect(isUpstreamOrigin('https://web.whatsapp.com/')).toBe(true)
    expect(isUpstreamOrigin('https://web.whatsapp.com/?locale=zh_CN#x')).toBe(true)
  })

  it('不接受 host 后缀与 userinfo 伪装', () => {
    expect(isUpstreamOrigin('https://web.whatsapp.com.evil.com/')).toBe(false)
    expect(isUpstreamOrigin('https://web.whatsapp.com@evil.com/')).toBe(false)
  })

  it('不接受非 https 与畸形输入', () => {
    expect(isUpstreamOrigin('http://web.whatsapp.com/')).toBe(false)
    expect(isUpstreamOrigin('not a url')).toBe(false)
    expect(isUpstreamOrigin('')).toBe(false)
    // 本地界面窗口走 file://，它的 origin 是 "null" —— 权限必须拒绝它。
    expect(isUpstreamOrigin('file:///opt/app/resources/app.asar/out/renderer/index.html')).toBe(
      false,
    )
  })

  it('不接受上游自己的其它域：它们不承载登录态', () => {
    expect(isUpstreamOrigin('https://webtp.whatsapp.net/pdf-viewer/')).toBe(false)
    expect(isUpstreamOrigin('https://static.whatsapp.net/rsrc.php/x.js')).toBe(false)
  })
})

describe('isUpstreamPage', () => {
  it('放行上游自己的页面，含 whatsapp.net 下的辅助页', () => {
    expect(isUpstreamPage('https://web.whatsapp.com/')).toBe(true)
    // 文档预览窗口就在这个域上：拒绝它的症状是预览打不开，且我们还会把这个需要
    // 登录态的地址交给系统浏览器。
    expect(isUpstreamPage('https://webtp.whatsapp.net/pdf-viewer/?locale=zh_CN')).toBe(true)
  })

  it('站外一律交给系统浏览器', () => {
    expect(isUpstreamPage('https://example.com/')).toBe(false)
    // 对外站点不是应用的一部分，留在应用内只会得到一个没有登录态的页面。
    expect(isUpstreamPage('https://www.whatsapp.com/')).toBe(false)
    expect(isUpstreamPage('https://evilwhatsapp.net/x')).toBe(false)
    expect(isUpstreamPage('https://whatsapp.net.evil.com/x')).toBe(false)
    expect(isUpstreamPage('https://web.whatsapp.com@evil.com/')).toBe(false)
  })
})
