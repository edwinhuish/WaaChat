/**
 * 产物冒烟测试（不需要显示器，也不启动 Electron）。
 *
 * 为什么它属于 `test/e2e/` 而不是 `test/unit/`：它验证的不是某个函数，而是
 * **编译之后真正要分发的那三个 bundle**。这两者的差别很实在 —— lint 能拦住源码里的
 * `executeJavaScript`，却拦不住某个依赖在打包后把它带进来。
 *
 * ⚠️ 依赖 `out/` 存在。因此它只在 `pnpm run build` 之后才有意义；PR 流程里先跑
 * `pnpm run check`（此时 `out/` 还没生成），因此这里**跳过而不失败**。
 * 要让它参与校验：`pnpm run build && pnpm run test`。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const OUT = join(process.cwd(), 'out')
const built = existsSync(join(OUT, 'main', 'index.js'))

/** 读产物文本。产物是机器生成的，读之前先确认存在，失败信息才有指向性。 */
function read(relative: string): string {
  const path = join(OUT, relative)
  expect(existsSync(path), `缺少构建产物 ${relative}（先跑 pnpm run build）`).toBe(true)
  return readFileSync(path, 'utf8')
}

describe.skipIf(!built)('构建产物', () => {
  it('三个 bundle 都在', () => {
    expect(existsSync(join(OUT, 'main', 'index.js'))).toBe(true)
    expect(existsSync(join(OUT, 'preload', 'index.js'))).toBe(true)
    expect(existsSync(join(OUT, 'renderer', 'index.html'))).toBe(true)
  })

  it('主进程产物里没有页面注入能力（INV-1 的产物级检查）', () => {
    const main = read('main/index.js')

    // 这两个 API 是"往页面里塞脚本/样式"的唯一手段。源码侧由 eslint 拦住，
    // 这里再对**编译后的产物**断言一次 —— 依赖也可能把它带进来。
    expect(main).not.toContain('executeJavaScript')
    expect(main).not.toContain('insertCSS')
  })

  it('preload 只暴露白名单桥，且不暴露 ipcRenderer 本身', () => {
    const preload = read('preload/index.js')

    expect(preload).toContain('exposeInMainWorld')
    // 暴露 ipcRenderer 等于把任意通道交给界面：白名单就白写了。
    expect(preload).not.toMatch(/exposeInMainWorld\(\s*['"][^'"]+['"]\s*,\s*ipcRenderer/)
  })

  it('界面产物没有内联脚本（CSP 里 script-src 只有 self）', () => {
    const html = read('renderer/index.html')

    // 内联脚本会被我们自己的 CSP 拦掉，表现为"窗口一片空白"。
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i)
    expect(html).toContain('Content-Security-Policy')
  })
})

describe.skipIf(built)('构建产物（跳过）', () => {
  it('out/ 不存在，跳过产物冒烟测试（pnpm run build 之后可跑）', () => {
    expect(built).toBe(false)
  })
})
