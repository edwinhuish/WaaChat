/**
 * User-Agent 构造。
 *
 * 为什么需要它：[INV-1] 禁止向页面注入脚本，因此我们不能用"改一改页面行为"
 * 的方式绕过兼容性检查。剩下的唯一手段就是在**请求层面**表现得像一个普通浏览器。
 *
 * Electron 默认 UA 里带有 `Electron/x.y.z` 标记。上游可能据此判定浏览器不受支持，
 * 或对部分能力（通话相关的媒体设备访问）做差异化处理。因此我们把 Electron 标记
 * 去掉，只保留一份与所带 Chromium 版本一致的 Chrome UA。
 *
 * 这是**纯函数**，因此可以在不加载 Electron 的情况下单测（见 test/unit/user-agent.test.ts）。
 */

/** 桌面 Linux 的 Chrome UA 模板。 */
const CHROME_UA_TEMPLATE =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version} Safari/537.36'

/**
 * UA 中绝不允许出现的标记，两类：
 *
 *   1. `Electron` —— Electron 会自动往默认 UA 里插这个标记。一旦漏进来，上游就能
 *      判定我们是嵌入式运行时，进而对能力（通话相关的媒体设备访问）做差异化处理；
 *   2. 应用自身的名字 —— 它同样暴露"这不是普通浏览器"。当前模板里当然不会出现，
 *      留着是为了拦住将来往模板里塞名字的改动。
 */
const FORBIDDEN_TOKENS = ['Electron', 'electron', 'waachat', 'WaaChat'] as const

/**
 * 构造 UA。
 *
 * @param chromeVersion 形如 `150.0.7871.129`。必须来自 `process.versions.chrome`
 *                      —— 手写一个固定版本会与实际的浏览器能力不符，而能力探测
 *                      恰恰是上游判定浏览器是否受支持的依据。
 */
export function buildUserAgent(chromeVersion: string): string {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(chromeVersion)) {
    throw new Error(`buildUserAgent: 需要完整的 Chromium 版本号，收到 "${chromeVersion}"`)
  }

  const ua = CHROME_UA_TEMPLATE.replace('{version}', chromeVersion)

  for (const token of FORBIDDEN_TOKENS) {
    if (ua.includes(token)) {
      throw new Error(`buildUserAgent: UA 中不能出现 "${token}"`)
    }
  }

  return ua
}

/** 自检用：判断一个 UA 是否干净（不含嵌入式运行时标记）。 */
export function isCleanUserAgent(ua: string): boolean {
  return !FORBIDDEN_TOKENS.some((token) => ua.includes(token))
}
