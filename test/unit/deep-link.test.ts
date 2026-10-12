/**
 * 深链接的单测（`src/shared/deep-link.ts`，[ADR-0083]）。
 *
 * 这一项的风险不在"能不能用"，而在**它把什么拼进了 URL**：目标 URL 是我们自己拼出来交给窗口
 * 导航的，因此这里每一条"拒绝"的用例都比"接受"的更重要 ——
 *
 *   1. **数字之外一个字符都不许进 URL**：`?phone=` 后面接一个 `&` 就能加出第二个查询参数，
 *      而那个 URL 是拿登录态去请求的。因此 `chatUrl()` 自己再滤一遍（不信任调用方）；
 *   2. **不从任意 URL 里"抠"数字**：`https://example.com/8613…` 里的数字不是号码，
 *      把它当号码的后果是"点了某个链接，应用开始给一个陌生号码发消息"；
 *   3. **认不出来时返回 `null` 而不是猜**：`argv` 里塞满 Chromium 自己的开关与启动路径。
 */

import { describe, expect, it } from 'vitest'

import {
  chatUrl,
  chatValueFromArgv,
  isChatLink,
  normalizeChatTarget,
  parseChatTarget,
} from '../../src/shared/deep-link'

const PHONE = '8613800000000'

describe('chatUrl', () => {
  it('拼成上游自己的那条路由', () => {
    expect(chatUrl(PHONE)).toBe(`https://web.whatsapp.com/send?phone=${PHONE}`)
  })

  it('只取数字：`&` / `#` / `/` 这类能把 URL 改出第二种结构的东西**全部消失**', () => {
    // 这一条是这整个文件里最重要的一条：字母与符号一起被 `\D` 去掉，因此拼出来的 URL 里除了
    // `?phone=` 那一个问号，剩下的只有数字 —— 结构上不可注入。
    expect(chatUrl(`${PHONE}&text=hi`)).toBe(`https://web.whatsapp.com/send?phone=${PHONE}`)
    expect(chatUrl(`${PHONE}#frag`)).toBe(`https://web.whatsapp.com/send?phone=${PHONE}`)
    expect(chatUrl(`../${PHONE}/x`)).toBe(`https://web.whatsapp.com/send?phone=${PHONE}`)

    // 一个数字都没有时清洗的结果是空号码。`chatUrl` 只负责清洗，"这个号码能不能用"由
    // `normalizeChatTarget` 判（两个入口都先过它），因此这一条是"清洗的边界"而不是漏洞。
    expect(chatUrl('../../etc/passwd')).toBe('https://web.whatsapp.com/send?phone=')
  })
})

describe('parseChatTarget', () => {
  it('认 `--new-chat <号码>` 与 `--new-chat=<号码>`', () => {
    expect(parseChatTarget(['/opt/waachat', '--new-chat', PHONE])).toBe(PHONE)
    expect(parseChatTarget([`--new-chat=${PHONE}`])).toBe(PHONE)
  })

  it('认号码的几种常见写法（`+`、空格、`-`、括号）', () => {
    expect(parseChatTarget(['--new-chat', '+86 138-0000-0000'])).toBe(PHONE)
    expect(parseChatTarget(['--new-chat', '+86 (138) 0000 0000'])).toBe(PHONE)
  })

  it('认系统协议处理器交过来的 `whatsapp:` 链接', () => {
    expect(parseChatTarget(['/opt/waachat', `whatsapp://send?phone=${PHONE}`])).toBe(PHONE)
    // 系统有时会给不带 `//` 的写法
    expect(parseChatTarget([`whatsapp:send?phone=${PHONE}`])).toBe(PHONE)
  })

  it('认 `wa.me` 链接（省了协议的写法也认）', () => {
    expect(parseChatTarget([`https://wa.me/${PHONE}`])).toBe(PHONE)
    expect(parseChatTarget([`wa.me/${PHONE}`])).toBe(PHONE)
    expect(parseChatTarget([`https://wa.me/${PHONE}?text=hi`])).toBe(PHONE)
    expect(parseChatTarget([`https://wa.me/?phone=${PHONE}`])).toBe(PHONE)
  })

  it('`--new-chat` 优先于 argv 里那条链接（那是用户当场敲的那一个）', () => {
    const argv = [`whatsapp://send?phone=4915112345678`, '--new-chat', PHONE]
    expect(parseChatTarget(argv)).toBe(PHONE)
  })

  it('认不出来就返回 null，绝不猜', () => {
    expect(parseChatTarget(['/opt/waachat'])).toBeNull()
    expect(parseChatTarget(['--profile', 'work'])).toBeNull()
    // `--new-chat` 后面什么都没有、或者后面跟的是另一个开关
    expect(parseChatTarget(['--new-chat'])).toBeNull()
    expect(parseChatTarget(['--new-chat', '--disable-gpu'])).toBeNull()
    // 号码形状不对：太短、太长、以 0 开头（本地写法，`?phone=` 要的是国际格式）
    expect(parseChatTarget(['--new-chat', '12345'])).toBeNull()
    expect(parseChatTarget(['--new-chat', '1234567890123456'])).toBeNull()
    expect(parseChatTarget(['--new-chat', '07700900123'])).toBeNull()
  })

  it('不从任意 URL 里抠数字（那是"给陌生号码发消息"，不是深链接）', () => {
    expect(parseChatTarget([`https://example.com/${PHONE}`])).toBeNull()
    expect(parseChatTarget([`https://wa.me.evil.com/${PHONE}`])).toBeNull()
    // ⚠️ 刻意不认它：`api.whatsapp.com` 不在我们的上游域里（shared/upstream.ts）
    expect(parseChatTarget([`https://api.whatsapp.com/send?phone=${PHONE}`])).toBeNull()
  })
})

describe('chatValueFromArgv', () => {
  it('返回"我们打算解释的那个原样值"（日志要用它说清读到了什么）', () => {
    expect(chatValueFromArgv(['--new-chat', 'abc'])).toBe('abc')
    expect(chatValueFromArgv(['--new-chat=abc'])).toBe('abc')
    expect(chatValueFromArgv(['whatsapp://send?phone=abc'])).toBe('whatsapp://send?phone=abc')
    expect(chatValueFromArgv(['/opt/waachat'])).toBeNull()
  })
})

describe('isChatLink', () => {
  it('只认 `whatsapp:` 与 `wa.me` 这两种形状', () => {
    expect(isChatLink(`whatsapp://send?phone=${PHONE}`)).toBe(true)
    expect(isChatLink(`https://wa.me/${PHONE}`)).toBe(true)
    expect(isChatLink(`http://wa.me/${PHONE}`)).toBe(true)
    expect(isChatLink(`wa.me/${PHONE}`)).toBe(true)

    expect(isChatLink('https://web.whatsapp.com/')).toBe(false)
    expect(isChatLink(`https://wa.me.evil.com/${PHONE}`)).toBe(false)
    expect(isChatLink('https://example.com/')).toBe(false)
    expect(isChatLink('not a url at all')).toBe(false)
    expect(isChatLink('')).toBe(false)
  })
})

describe('normalizeChatTarget', () => {
  it('与 `parseChatTarget` 用同一份实现（两个入口只应该有一份判据）', () => {
    expect(normalizeChatTarget('+86 138-0000-0000')).toBe(PHONE)
    expect(normalizeChatTarget(`whatsapp://send?phone=${PHONE}`)).toBe(PHONE)
    expect(normalizeChatTarget('')).toBeNull()
    expect(normalizeChatTarget('   ')).toBeNull()
  })
})
