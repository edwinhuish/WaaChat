/**
 * 页面侧语言探针的单测（`test/fixtures/probe-lang-pref.js`）。
 *
 * 为什么值得测：这份夹具的唯一产出是**一份会被整段贴出来的报告**，而它有两条会**静默**
 * 坏掉的性质：
 *
 *   1. **只报 cookie 名字、值另按"看起来像语言码"收敛**。破掉的后果不是报错，而是把同一份
 *      cookie 串里的会话凭据（`wa_ul` 之类）打进了报告 —— 而报告是拿去贴的。
 *   2. **判定行必须跟着事实变**。"脚本看不见它"这一支如果被写成一个绝对的结论
 *      （"所以它是 HttpOnly"），读报告的人就会把一个**还没被写过**的 cookie 当成形态 A，
 *      照着去拦响应头 —— 那是一次建立在错误前提上的改动。
 *
 * 与 `dev-probe-source.test.ts` 同一个做法：不比对字符串，而是把注入代码**真跑一遍**看结果。
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  LANG_PROBE_SOURCE_RELATIVE_PATH,
  langProbeSourcePath,
} from '../../src/main/dev-probe-source'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

interface StorageLike {
  readonly length: number
  key: (index: number) => string | null
  getItem: (key: string) => string | null
}

interface ProbeApi {
  refresh: () => Promise<unknown>
  report: () => string
}

interface FakeWindow {
  __waLangPref?: ProbeApi
  [key: string]: unknown
}

/** 用给定的一组键值造一个 `localStorage` 形状的东西（`key(i)` 是它的枚举入口）。 */
function fakeStorage(entries: Record<string, string>): StorageLike {
  const keys = Object.keys(entries)

  return {
    length: keys.length,
    key: (index) => keys[index] ?? null,
    getItem: (key) => entries[key] ?? null,
  }
}

interface HarnessOptions {
  readonly cookie?: string
  readonly localStorage?: Record<string, string>
  readonly sessionStorage?: Record<string, string>
  readonly indexedDB?: unknown
  readonly language?: string
  readonly search?: string
}

/**
 * 与真实注入同一时刻求值：`did-finish-load`（页面已可用），只给 `window` / `console` 两个入口
 * —— 夹具本来就只有这些（这也是它不能有 `import` 的原因）。
 */
function evaluate(options: HarnessOptions = {}) {
  const logs: string[] = []
  const window: FakeWindow = {
    document: { cookie: options.cookie ?? '' },
    localStorage: fakeStorage(options.localStorage ?? {}),
    sessionStorage: fakeStorage(options.sessionStorage ?? {}),
    indexedDB: options.indexedDB,
    navigator: { language: options.language ?? 'zh-CN', languages: ['zh-CN', 'en'] },
    location: {
      origin: 'https://web.whatsapp.com',
      pathname: '/',
      search: options.search ?? '',
    },
  }

  const spyConsole = {
    info: (...args: unknown[]) => logs.push(args.join(' ')),
    warn: (...args: unknown[]) => logs.push(args.join(' ')),
    log: (...args: unknown[]) => logs.push(args.join(' ')),
  }

  const source = readFileSync(langProbeSourcePath(REPO_ROOT), 'utf8')
  new Function('window', 'console', source)(window, spyConsole)

  return { window, output: () => logs.join('\n') }
}

const cookieHeader = (extra = '') => `wa_ul=SENTINELSESSIONVALUE; wa_web_lang_pref=zh-CN${extra}`

describe('语言探针：页面侧', () => {
  it('指向仓库里那份真的夹具 —— 挪走了这一条就会红', () => {
    const path = langProbeSourcePath(REPO_ROOT)

    expect(path.endsWith(LANG_PROBE_SOURCE_RELATIVE_PATH)).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8').length).toBeGreaterThan(0)
  })

  it('装完就取一次快照，且取之前 report() 只提示、不抛错', () => {
    const { window, output } = evaluate({ cookie: cookieHeader() })

    // 同步拿到的那一刻快照还没回来（snapshot 是异步的，`databases()` 要 await）。
    expect(window.__waLangPref?.report()).toContain('还没取过快照')
    expect(typeof window.__waLangPref?.refresh).toBe('function')
    expect(output()).toContain('已装载')
  })

  it('cookie 对脚本可见时：报出语言码，并指明区分形态 A/B 要看主进程日志', async () => {
    const { window } = evaluate({ cookie: cookieHeader() })
    await window.__waLangPref?.refresh()

    const report = window.__waLangPref?.report() ?? ''

    expect(report).toContain('wa_web_lang_pref：可见（值 zh-CN）')
    expect(report).toContain('不是** HttpOnly')
    expect(report).toContain('lang probe: cookie changed')
    expect(report).toContain('explicit')
  })

  it('绝不打印同一份 cookie 串里别的值（报告是拿去贴的）', async () => {
    const { window } = evaluate({ cookie: cookieHeader('; wa_browser_id=SENTINELBROWSERID') })
    await window.__waLangPref?.refresh()

    const report = window.__waLangPref?.report() ?? ''

    // 名字可以出现（那是有用的元数据），值一个字节都不许出去。
    expect(report).not.toContain('SENTINELSESSIONVALUE')
    expect(report).not.toContain('SENTINELBROWSERID')
  })

  it('cookie 对脚本不可见时：给出两种可能，而不是断言它就是 HttpOnly', async () => {
    const { window } = evaluate({ cookie: 'wa_ul=SENTINELSESSIONVALUE' })
    await window.__waLangPref?.refresh()

    const report = window.__waLangPref?.report() ?? ''

    expect(report).toContain('不可见')
    expect(report).toContain('HttpOnly')
    expect(report).toContain('还没被写过')
    expect(report).toContain('httpOnly: true')
  })

  it('页面存储：疑似语言键报键名与规范化后的值，非语言键一个字都不进报告', async () => {
    const { window } = evaluate({
      cookie: cookieHeader(),
      localStorage: {
        'wa-lang-pref': 'zh-CN',
        'some-token': 'SENTINELTOKEN',
        theme: 'dark',
      },
    })
    await window.__waLangPref?.refresh()

    const report = window.__waLangPref?.report() ?? ''

    expect(report).toContain('wa-lang-pref = zh-CN')
    expect(report).not.toContain('SENTINELTOKEN')
    expect(report).not.toContain('some-token')
    expect(report).not.toContain('theme')
  })

  it('非语言码的存储值只报长度（值可能是凭据，绝不打出来）', async () => {
    const { window } = evaluate({
      cookie: cookieHeader(),
      localStorage: { 'lang-token': 'SENTINELTOKENVALUE' },
    })
    await window.__waLangPref?.refresh()

    const report = window.__waLangPref?.report() ?? ''

    expect(report).toContain('lang-token = len=18')
    expect(report).not.toContain('SENTINELTOKENVALUE')
  })

  it('IndexedDB 只列库名，并明确说"不进去读"', async () => {
    const { window } = evaluate({
      cookie: cookieHeader(),
      indexedDB: { databases: async () => [{ name: 'model-storage' }, { name: 'wa-web' }] },
    })
    await window.__waLangPref?.refresh()

    const report = window.__waLangPref?.report() ?? ''

    expect(report).toContain('model-storage')
    expect(report).toContain('wa-web')
    expect(report).toContain('不进去读')
  })

  it('没有 indexedDB.databases() 时说明"没测到"，而不是当成"没有"', async () => {
    const { window } = evaluate({ cookie: cookieHeader() })
    await window.__waLangPref?.refresh()

    expect(window.__waLangPref?.report()).toContain('没有 `indexedDB.databases()`')
  })

  it('把 navigator 与 `?lang=` 那一问都写进报告（后者还没测，要说明怎么测）', async () => {
    const { window } = evaluate({ cookie: cookieHeader() })
    await window.__waLangPref?.refresh()

    const report = window.__waLangPref?.report() ?? ''

    expect(report).toContain('navigator.language = zh-CN')
    expect(report).toContain('?lang=')
    expect(report).toContain('web.whatsapp.com/?lang=ja-JP')
  })

  it('地址里出现 lang 参数时，只报参数名与它的值', async () => {
    const { window } = evaluate({
      cookie: cookieHeader(),
      search: '?lang=ja-JP&token=SENTINELQUERYVALUE',
    })
    await window.__waLangPref?.refresh()

    const report = window.__waLangPref?.report() ?? ''

    expect(report).toContain('lang = ja-JP')
    expect(report).not.toContain('SENTINELQUERYVALUE')
  })
})
