/**
 * 深链接的**主进程**那一半（[ADR-0083]）：声明 scheme、把一份命令行解释成"该打开哪个对话的
 * URL"。
 *
 * 判据与归一化在 `shared/deep-link.ts`（纯函数、可单测）；这里只做两件事 —— 告诉系统这个
 * scheme 归我们，以及把 `process.argv` / `second-instance` 的那份 argv 变成一个 URL。
 * 真正的导航在 `window.ts` 的 `openChat()`：那里离窗口最近，而且另一条入口（页面里点的
 * `wa.me` 链接）也在那儿，两条入口共用同一句话，才不会有"命令行能开、点链接不能开"这种半截状态。
 */

import { app } from 'electron'

import { CHAT_PROTOCOL, chatValueFromArgv, parseChatTarget } from '../shared/deep-link'
import { logger } from './logger'

/**
 * Electron 要的是不带冒号的 scheme 名（`whatsapp:` → `whatsapp`）。
 *
 * 它同时是 `.desktop` 里 `MimeType=x-scheme-handler/<这个名字>;` 的那一段 —— 两份声明
 * （打包那份与用户换图标之后生效的那份）都从 `shared/deep-link.ts` 的 `CHAT_PROTOCOL` 派生，
 * 因此不存在"注册了一个我们不认的 scheme"这种半截状态。
 */
const PROTOCOL = CHAT_PROTOCOL

/**
 * 声明"`whatsapp:` 归我们"。
 *
 * ⚠️ Linux 上真正决定关联的是安装包里那条 `.desktop` 的
 * `MimeType=x-scheme-handler/whatsapp;`（electron-builder.yml 的 `linux.desktop.entry`，
 * `scripts/verify-package.sh` 会断言它确实在产物里）。这一行是给 Windows / macOS、以及
 * "用户自己指定过默认程序"的情况兜底的。
 *
 * ⚠️ **只在打包之后调用**。开发模式下 `execPath` 指向 `node_modules` 里那个 Electron 二进制，
 * 把系统关联指向它的后果是"用户下次点链接会起一个没有我们代码的 Electron" —— 一次**安静**的
 * 破坏（要等用户点链接才发现），而且用户不会把它与"昨天跑过 dev"联系起来。
 *
 * 返回值是 `false` 时只记一条 warn：可能只是本机没有 `xdg-settings`（或用户自己指定过别的
 * 程序），此时链接仍然由 `.desktop` 那条路走通 —— 不值得为此拦住启动。
 */
export function registerChatProtocol(): void {
  if (!app.isPackaged) {
    logger.info('deep link: not registering the scheme in a dev run', { protocol: PROTOCOL })
    return
  }

  const registered = app.setAsDefaultProtocolClient(PROTOCOL)
  logger.info('deep link: scheme registration attempted', { protocol: PROTOCOL, registered })
}

/**
 * 从一份命令行里取出"要打开哪个对话"（E.164 的数字部分；没有就是 `null`），顺便把认不出来的
 * 情况记进日志。
 *
 * ⚠️ **两个入口共用它**：启动时（`process.argv`）与再次启动时（`second-instance` 把第二个进程的
 * argv 交给我们）。分两处写的症状是"从已运行的实例里点链接没反应" —— 而那恰好是最常见的一次。
 *
 * ⚠️ 返回值是**号码**，不是 URL：URL 只由 `chatUrl()` 拼（只取数字），命令行里的原始字符串
 * **从不**被交给窗口。
 *
 * 日志纪律：认不出来时记的是**用户自己写的那个值**（它本来就是用户输入）；认出来之后只记
 * "要开一个对话"，不记号码。
 */
export function chatTargetFromArgv(argv: readonly string[]): string | null {
  const target = parseChatTarget(argv)

  if (target === null) {
    const raw = chatValueFromArgv(argv)
    if (raw !== null) {
      /**
       * 用户明确表达了"要开一个对话"，但我们用不了那个值（号码形状不对，或者是一条我们不认的
       * 链接）。**必须留下原样值**：否则用户只看到"点了没反应"，而我们这边一条线索都没有。
       */
      logger.warn('deep link: not a usable chat target', { value: raw })
    }
    return null
  }

  return target
}
