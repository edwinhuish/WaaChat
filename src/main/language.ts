/**
 * 会话级的 **User-Agent 与 Accept-Language**。
 *
 * [INV-1] 禁止向被承载的页面注入任何东西，因此"让上游页面换一种语言"只剩**表现得像一个普通
 * 浏览器**这一条路 —— 与 `shared/user-agent.ts` 里"去掉 `Electron/` 标记"是同一个思路，
 * 只是那一位管"看起来是不是普通浏览器"，这一位管"看起来说哪种语言"。
 *
 * ⚠️ **这一层不是决定性的那一半**（[ADR-0063]）。网页版是纯 JS 应用，按 `navigator.language`
 * 挑自己的语言包，而那个值来自**应用 locale**：实测（Electron 44.7）只设这里的
 * `acceptLanguages`，`navigator.language` 依旧是系统的 `zh-CN` —— 一个字节都不变。真正的杠杆
 * 是启动期的 `--lang` 开关（`main/index.ts`）。这里保留的是**请求头**那一半：有序回退（主语言
 * 之外还要带上 `en`），以及把 UA 与它成对下发。
 *
 * ⚠️ **为什么 UA 也在这个文件里**（而不是留在 `window.ts`）：Electron 里能设 `acceptLanguages`
 * 的**只有** `session.setUserAgent(userAgent, acceptLanguages)` 这一个入口 ——
 * `webContents.setUserAgent()` 的签名只有 UA 一个参数。两者因此必然成对出现，也就必然要留在
 * 同一个地方；否则会出现"会话设了语言、窗口又把 UA 覆盖回去"这种一半生效、且**没有任何报错**的
 * 状态（`window.ts` 里删掉的那一行就是这么来的）。
 *
 * 本文件只 `import type` electron，不 import 它的运行时代码：离线自检因此能读它的判据
 * （与 `permissions.ts` 同一个理由）。
 */

import type { Session } from 'electron'

import { acceptLanguagesFor } from '../shared/language'
import type { Settings } from '../shared/types'
import { buildUserAgent, isCleanUserAgent } from '../shared/user-agent'
import { logger } from './logger'

/**
 * 把 UA 与界面语言写到会话上。
 *
 * 调用时机**只有一个**：`configureSession()` —— **早于任何窗口创建**，因此页面的第一次导航
 * 就用上它。（[ADR-0063] 之前还有第二个调用点：改设置之后重设 + 重载页面。那条路被去掉了，
 * 因为它改不动 `navigator.language` —— 界面语言现在是**重启后生效**，见 `index.ts` 的
 * `--lang`。）
 *
 * 反过来，只要还有哪扇窗口自己调过 `webContents.setUserAgent()`，它就会用自己那份（只有 UA、
 * 没有语言）盖掉这里 —— 因此承载上游页面的窗口**不**自己设 UA（自检第 19 节断言这一点）。
 */
export function applyUserAgentAndLanguages(ses: Session, settings: Settings): void {
  const userAgent = buildUserAgent(process.versions.chrome)

  ses.setUserAgent(userAgent, acceptLanguagesFor(settings.uiLanguage))

  /**
   * 记的是"UA 干净吗"与"哪一门语言"，不是完整的 `Accept-Language` 头：前者是这一类改动最容易
   * 坏掉的地方（上游会据此判定浏览器是否受支持），而后者足够定位"用户选的语言到底有没有落下去"。
   */
  logger.info('session: user agent and accept-languages applied', {
    userAgentClean: isCleanUserAgent(userAgent),
    uiLanguage: settings.uiLanguage,
  })
}
