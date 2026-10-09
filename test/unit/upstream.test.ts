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

import { isDocumentPreviewPage, isUpstreamOrigin, isUpstreamPage } from '../../src/shared/upstream'

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
    expect(isUpstreamOrigin('file:///opt/app/resources/app.asar/out/renderer/files.html')).toBe(
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
    // 这个函数只回答"是不是上游自己的页面"，文档预览页也算 —— 它另有判据，
    // 由 {@link isDocumentPreviewPage} 在窗口处理与请求拦截里被拒（ADR-0029）。
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

describe('isDocumentPreviewPage', () => {
  it('认得上游的文档预览页 —— 它是把 PDF 送进内核内置阅读器的入口', () => {
    expect(isDocumentPreviewPage('https://webtp.whatsapp.net/pdf-viewer/?locale=zh_CN')).toBe(true)
    expect(isDocumentPreviewPage('https://webtp.whatsapp.net/pdf-viewer/')).toBe(true)
    // 判据是"上游域 + 这个路径"，**不限定**哪个 host：预览页落在哪个上游域上是对方的事
    // （实测在 `webtp` 上）。按 host 写死的话，它换一个域我们就静默放行了 —— 而症状
    // 是应用内又出现 PDF 预览，没人会想到这里。
    expect(isDocumentPreviewPage('https://web.whatsapp.com/pdf-viewer/')).toBe(true)
  })

  it('同域下的其它页面不算', () => {
    expect(isDocumentPreviewPage('https://webtp.whatsapp.net/rsrc.php/x.js')).toBe(false)
    // 判据是**路径前缀**，不是"路径里出现过这个词"：宽松一点点就会误伤上游别的页面。
    expect(isDocumentPreviewPage('https://webtp.whatsapp.net/x/pdf-viewer/')).toBe(false)
  })

  it('别的源即使路径相同也不算', () => {
    expect(isDocumentPreviewPage('https://webtp.whatsapp.net.evil.com/pdf-viewer/')).toBe(false)
    expect(isDocumentPreviewPage('https://whatsapp.net.evil.com/pdf-viewer/')).toBe(false)
    expect(isDocumentPreviewPage('https://example.com/pdf-viewer/')).toBe(false)
    // 把真地址塞进查询串不改变 host —— 前缀匹配的老毛病正是栽在这类输入上。
    expect(
      isDocumentPreviewPage('https://evil.com/?u=https://webtp.whatsapp.net/pdf-viewer/'),
    ).toBe(false)
    expect(isDocumentPreviewPage('not a url')).toBe(false)
  })
})
