/**
 * 开发探针**注入源**的单测（`src/main/dev-probe-source.ts`）。
 *
 * 为什么值得测：注入是个"装不上也不报错"的动作。三种坏法都**静默**：
 *
 *   1. 探针被挪走 / 改名 ⇒ 注入静默不生效，控制台里没有 `__waProbe`，但主进程只留一条 warn；
 *   2. 注入方设的标记名与探针读的名字不一致 ⇒ 退化成"上游未就绪就扫描"，
 *      打出一条**假警报**（"没找到消息集合，上游把结构换了位置"）—— 而那是真诊断，会被记错；
 *   3. 标记设了就一直在 ⇒ 之后手动粘贴本文件不再自动扫描，症状是"粘了却没反应"。
 *
 * 所以这里不比对字符串，而是把注入代码**真跑一遍**看结果。
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  LANG_PROBE_GLOBAL,
  LANG_PROBE_SOURCE_RELATIVE_PATH,
  PROBE_BOOTSTRAP_FLAG,
  PROBE_GLOBAL,
  PROBE_SOURCE_RELATIVE_PATH,
  langProbeSourcePath,
  probeBootstrapCode,
  probeReadyExpression,
  probeScanExpression,
  probeSourcePath,
} from '../../src/main/dev-probe-source'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

interface ProbeApi {
  scan: () => unknown
  ready: () => boolean
  report: () => string
}

interface InjectedWindow {
  require: (name: string) => unknown
  __waProbe?: ProbeApi
  [key: string]: unknown
}

/**
 * 与真实注入在同一时刻求值：页面**刚加载完**，所以 `window.require` 拿不到任何东西。
 *
 * 只给 `window` / `console` 两个入口 —— 探针本来就只有这些（这也是它不能有 `import` 的原因）。
 */
function evaluate(code: string) {
  const logs: string[] = []
  const tables: unknown[][] = []
  const window: InjectedWindow = { require: () => undefined }

  const spyConsole = {
    info: (...args: unknown[]) => logs.push(args.join(' ')),
    warn: (...args: unknown[]) => logs.push(args.join(' ')),
    log: (...args: unknown[]) => logs.push(args.join(' ')),
    table: (rows: unknown) => tables.push(rows as unknown[]),
    group: () => {},
    groupEnd: () => {},
  }

  new Function('window', 'console', code)(window, spyConsole)

  return { window, output: () => logs.join('\n'), tables }
}

const probeSource = () => readFileSync(probeSourcePath(REPO_ROOT), 'utf8')

describe('开发探针：注入源', () => {
  it('指向仓库里那份真的探针 —— 挪走了这一条就会红', () => {
    const path = probeSourcePath(REPO_ROOT)

    expect(path.endsWith(PROBE_SOURCE_RELATIVE_PATH)).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(probeSource().length).toBeGreaterThan(0)
  })

  it('注入只装 API、不立刻扫描 —— 否则上游未就绪时会打出一条假警报', () => {
    const { window, output, tables } = evaluate(probeBootstrapCode(probeSource()))

    expect(window.__waProbe).toBeDefined()
    expect(output()).toContain('已由开发模式装载')
    // 这条只可能出现在"扫描了、但没找到消息集合"那条路上：一个字都不该出现。
    expect(output()).not.toContain('没找到消息集合')
    expect(tables).toHaveLength(0)
  })

  it('标记读完就删 —— 之后手动粘贴本文件仍然会自动扫描', () => {
    const { window } = evaluate(probeBootstrapCode(probeSource()))

    expect(window[PROBE_BOOTSTRAP_FLAG]).toBeUndefined()
  })

  it('粘贴的语义仍是立即扫描（同一个页面里没有 store ⇒ 那条真诊断必须出现）', () => {
    const { window, output } = evaluate(probeSource())

    expect(output()).toContain('没找到消息集合')
    // 失败也不能让 API 缺席：诊断完还要能继续用（比如换个会话再扫）。
    expect(typeof window.__waProbe?.scan).toBe('function')
    expect(typeof window.__waProbe?.report).toBe('function')
  })

  it('就绪与扫描的表达式指向注入时定义的那个全局对象', () => {
    expect(probeReadyExpression()).toContain(`window.${PROBE_GLOBAL}`)
    expect(probeScanExpression()).toContain(`window.${PROBE_GLOBAL}`)
  })

  /**
   * 语言探针走**同一个注入通道**（`dev-probe.ts` 里那一处 `executeJavaScript`），因此这里只
   * 守两件事：它指向的夹具真的在仓库里，且两个探针不共用全局对象 —— 共用会互相覆盖状态，
   * 症状是"装了两个、只有一个能用"。
   */
  it('语言探针也指向仓库里那份真夹具，且与媒体探针不共用全局对象', () => {
    const path = langProbeSourcePath(REPO_ROOT)

    expect(path.endsWith(LANG_PROBE_SOURCE_RELATIVE_PATH)).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8').length).toBeGreaterThan(0)
    expect(LANG_PROBE_GLOBAL).not.toBe(PROBE_GLOBAL)
  })
})
