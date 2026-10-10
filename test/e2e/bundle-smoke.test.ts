/**
 * 产物冒烟测试（不需要显示器，也不启动 Electron）。
 *
 * 为什么它属于 `test/e2e/` 而不是 `test/unit/`：它验证的不是某个函数，而是
 * **编译之后真正要分发的那三个 bundle** —— 入口是否齐全、桥是否收敛、CSP 是否在位，
 * 这些只有对产物断言才看得见。
 *
 * 注：这里曾有一条"主进程产物里没有 `executeJavaScript` / `insertCSS`"的断言（INV-1 的
 * 产物级检查）。它随 [ADR-0043](../../docs/decisions.md#adr-0043) 撤销 INV-1 而删除 ——
 * 现行路线以 `whatsapp-web.js` 承载，注入能力是允许的。
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

/**
 * 渲染入口：**两扇窗口各一个**（文件列表 / 设置，见 ADR-0025）。
 *
 * 写成列表逐项断言，是因为漏掉一个入口的失败方式很隐蔽：构建**不报错**，只有那扇窗口
 * 打开时白屏（`loadFile`/`loadURL` 打不开一个不存在的文件，Electron 只会在控制台留一行）。
 */
const RENDERER_ENTRIES = ['files.html', 'settings.html'] as const

/** 读产物文本。产物是机器生成的，读之前先确认存在，失败信息才有指向性。 */
function read(relative: string): string {
  const path = join(OUT, relative)
  expect(existsSync(path), `缺少构建产物 ${relative}（先跑 pnpm run build）`).toBe(true)
  return readFileSync(path, 'utf8')
}

describe.skipIf(!built)('构建产物', () => {
  it('三个 bundle 都在（renderer 是两个入口）', () => {
    expect(existsSync(join(OUT, 'main', 'index.js'))).toBe(true)
    expect(existsSync(join(OUT, 'preload', 'index.js'))).toBe(true)

    for (const entry of RENDERER_ENTRIES) {
      expect(existsSync(join(OUT, 'renderer', entry)), `缺少渲染入口 ${entry}`).toBe(true)
    }
  })

  it('preload 只暴露白名单桥，且不暴露 ipcRenderer 本身', () => {
    const preload = read('preload/index.js')

    expect(preload).toContain('exposeInMainWorld')
    // 暴露 ipcRenderer 等于把任意通道交给界面：白名单就白写了。
    expect(preload).not.toMatch(/exposeInMainWorld\(\s*['"][^'"]+['"]\s*,\s*ipcRenderer/)
  })

  it('界面产物没有内联脚本（CSP 里 script-src 只有 self）', () => {
    // 两个入口都要查：每个入口各带一份 CSP meta，漏改一个的表现同样是白屏。
    for (const entry of RENDERER_ENTRIES) {
      const html = read(`renderer/${entry}`)

      // 内联脚本会被我们自己的 CSP 拦掉，表现为"窗口一片空白"。
      expect(html, `${entry} 里有内联脚本`).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i)
      expect(html, `${entry} 缺少 CSP meta`).toContain('Content-Security-Policy')
    }
  })
})

describe.skipIf(built)('构建产物（跳过）', () => {
  it('out/ 不存在，跳过产物冒烟测试（pnpm run build 之后可跑）', () => {
    expect(built).toBe(false)
  })
})
