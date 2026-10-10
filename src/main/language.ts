/**
 * 会话级的 **User-Agent 与 Accept-Language**。
 *
 * [INV-1] 禁止向被承载的页面注入任何东西，因此"让上游页面换一种语言"只剩**请求层面**这一条路：
 * 改 `Accept-Language`，页面自己据此挑它的语言包 —— 与 `shared/user-agent.ts` 里"去掉
 * `Electron/` 标记"是同一个思路，只是那一位管"看起来是不是普通浏览器"，这一位管"看起来说哪种
 * 语言"。
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
 * 调用时机只有两个，都不是随手加的：
 *
 *   1. `configureSession()` —— **早于任何窗口创建**，因此页面的第一次导航就用上它；
 *   2. 设置里的 `uiLanguage` 被改动之后 —— 与一次页面重载配对（见 `ipc/index.ts`）。
 *
 * Electron 的文档写着这次调用"**不影响已存在的 WebContents**"，所以第 2 种情况必须跟着重载
 * 页面，否则那句"改完就能生效"是假的。反过来，只要还有哪扇窗口自己调过
 * `webContents.setUserAgent()`，它就会用自己那份（只有 UA、没有语言）盖掉这里 —— 因此
 * 承载上游页面的窗口现在**不再**自己设 UA。
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
