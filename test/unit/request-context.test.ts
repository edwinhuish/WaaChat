/**
 * 直通重发时补回 fetch 元数据的单测（[ADR-0058]）。
 *
 * 防的是同一个事故：会话级 `protocol.handle('https')` 把所有 https 请求都接住之后，
 * 直通只能用 `ses.fetch` 重发，而重发出去的那一份会被内核当成"主进程发起的无上下文请求"
 * （`Sec-Fetch-Site: none` / `Mode: no-cors` / `Dest: empty`，`Referer` 丢失）。上游
 * `vary: Sec-Fetch-Site, Sec-Fetch-Mode`，于是文档预览页拿到的是**没有 CORP 的那一份变体**，
 * 在 COEP 父文档里被判"不可嵌入" ⇒ `ERR_BLOCKED_BY_RESPONSE` ⇒ 预览面板一直转圈。
 *
 * 这里断言的就是补偿本身：角色换算、排队与取出、以及"取不到时不许写坏请求"。
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  FETCH_METADATA_BY_RESOURCE_TYPE,
  applyRequestContext,
  clearRequestContexts,
  rememberRequestContext,
} from '../../src/main/capture/request-context'

const PREVIEW = 'https://webtp.whatsapp.net/pdf-viewer/?locale=zh_CN'

function remember(resourceType: string, url: string, referrer: string, method = 'GET'): void {
  rememberRequestContext({ method, url, resourceType, referrer })
}

describe('FETCH_METADATA_BY_RESOURCE_TYPE', () => {
  it('导航类角色换算成 navigate，且只有顶层带 ?1', () => {
    expect(FETCH_METADATA_BY_RESOURCE_TYPE.mainFrame).toEqual({
      mode: 'navigate',
      dest: 'document',
      user: '?1',
    })
    // 子框架是 navigate，但**没有** Sec-Fetch-User —— 与真浏览器一致（实测）。
    expect(FETCH_METADATA_BY_RESOURCE_TYPE.subFrame).toEqual({ mode: 'navigate', dest: 'iframe' })
  })

  it('不收录 other：那是我们自己重发出去的那一份', () => {
    expect(FETCH_METADATA_BY_RESOURCE_TYPE.other).toBeUndefined()
  })

  it('不收录 media：video/audio 两种 dest 分不出来，宁可少补', () => {
    expect(FETCH_METADATA_BY_RESOURCE_TYPE.media).toBeUndefined()
  })
})

describe('applyRequestContext', () => {
  beforeEach(() => clearRequestContexts())

  it('把子框架文档的角色与 Referer 补回重发的请求上', () => {
    remember('subFrame', PREVIEW, 'https://web.whatsapp.com/')

    const request = new Request(PREVIEW)
    applyRequestContext(request)

    expect(request.headers.get('Sec-Fetch-Mode')).toBe('navigate')
    expect(request.headers.get('Sec-Fetch-Dest')).toBe('iframe')
    expect(request.headers.get('Referer')).toBe('https://web.whatsapp.com/')
    // 顶层导航才有的那个头不该出现。
    expect(request.headers.get('Sec-Fetch-User')).toBeNull()
  })

  it('顶层导航带上 Sec-Fetch-User', () => {
    remember('mainFrame', 'https://web.whatsapp.com/', '')

    const request = new Request('https://web.whatsapp.com/')
    applyRequestContext(request)

    expect(request.headers.get('Sec-Fetch-Dest')).toBe('document')
    expect(request.headers.get('Sec-Fetch-User')).toBe('?1')
  })

  it('取不到记录时只补 Referer，不动内核默认的 Sec-Fetch-*', () => {
    const request = new Request('https://example.com/x', { referrer: 'https://web.whatsapp.com/' })
    applyRequestContext(request)

    expect(request.headers.get('Referer')).toBe('https://web.whatsapp.com/')
    expect(request.headers.get('Sec-Fetch-Mode')).toBeNull()
    expect(request.headers.get('Sec-Fetch-Dest')).toBeNull()
  })

  it('不把 Request.referrer 的哨兵值 about:client 写成 Referer', () => {
    // new Request(url) 的默认 referrer 就是 'about:client'：它不是一个地址，
    // 写进 Referer 会造出畸形请求。
    expect(new Request('https://example.com/x').referrer).toBe('about:client')

    const request = new Request('https://example.com/x')
    applyRequestContext(request)

    expect(request.headers.get('Referer')).toBeNull()
  })

  it('同一 URL 的两个请求按先后各取各的角色', () => {
    remember('subFrame', PREVIEW, 'https://web.whatsapp.com/')
    remember('xhr', PREVIEW, 'https://web.whatsapp.com/')

    const first = new Request(PREVIEW)
    const second = new Request(PREVIEW)
    applyRequestContext(first)
    applyRequestContext(second)

    expect(first.headers.get('Sec-Fetch-Mode')).toBe('navigate')
    expect(second.headers.get('Sec-Fetch-Mode')).toBe('cors')
    expect(second.headers.get('Sec-Fetch-Dest')).toBe('empty')
  })

  it('认不出角色的请求不进队列，于是重发也不会串味', () => {
    // 我们重发出去的那一份 resourceType 恒为 other。
    remember('other', PREVIEW, 'https://web.whatsapp.com/')

    const request = new Request(PREVIEW)
    applyRequestContext(request)

    expect(request.headers.get('Sec-Fetch-Mode')).toBeNull()
  })

  it('带 body 的 POST 也按 method + url 配对', () => {
    remember('xhr', 'https://web.whatsapp.com/api', '', 'POST')

    const request = new Request('https://web.whatsapp.com/api', { method: 'POST', body: 'a=1' })
    applyRequestContext(request)

    expect(request.headers.get('Sec-Fetch-Mode')).toBe('cors')
  })
})

describe('clearRequestContexts', () => {
  it('摘掉密文层之后不再留下任何角色', () => {
    remember('subFrame', PREVIEW, 'https://web.whatsapp.com/')
    clearRequestContexts()

    const request = new Request(PREVIEW)
    applyRequestContext(request)

    expect(request.headers.get('Sec-Fetch-Mode')).toBeNull()
  })
})
