/**
 * 深链接的判据与归一化（[ADR-0083]）。
 *
 * 要回答两件事：
 *
 *   1. 系统把链接当成命令行参数交给我们（`whatsapp:` 协议处理器、`xdg-open`），或者用户自己
 *      写了 `--new-chat <号码>` 时，"要打开哪个对话"是什么；
 *   2. 那个答案怎么变成**上游自己的那条路由** —— `https://web.whatsapp.com/send?phone=…`。
 *
 * ⚠️ 这条路径上**没有任何"把字符串交给页面"的动作**：URL 是我们自己拼出来的，然后让主窗口
 * 导航过去（INV-1：不注入、不驱动页面）。因此这里唯一需要认真对待的是**号码的形状**：
 * 拼进 URL 的只允许是数字，别的字符一个都不许进 —— 否则用户（或一个伪造的链接）就能改
 * URL 的结构。{@link chatUrl} 因此自己再滤一遍，而不是信任调用方。
 *
 * 纯函数、不导入 electron —— 因此可以被单测与 `scripts/check-capture.ts` 直接使用
 * （见 ai/CONVENTIONS.md 第 8 节）。
 */

import { UPSTREAM_ORIGIN } from './constants'

/** 选择"要打开的对话"的命令行参数（`--new-chat 8613…` 与 `--new-chat=8613…` 都接受）。 */
export const CHAT_ARG = '--new-chat'

/** 上游那条"发消息给某个号码"的路由。 */
const SEND_URL = `${UPSTREAM_ORIGIN}/send`

/**
 * scheme 的**名字**（不带冒号）。
 *
 * 它是三个地方的同一份事实，因此只在这里写一遍：
 *
 *   1. 判据（{@link isChatLink} 认 `whatsapp:` 开头的链接）；
 *   2. 主进程的注册（`main/deep-link.ts` 的 `setAsDefaultProtocolClient`）；
 *   3. `.desktop` 里的 `MimeType=x-scheme-handler/whatsapp;` —— 打包那份在
 *      `electron-builder.yml`，而**用户换过图标之后生效的那份**在
 *      `shared/appicon.ts` 的 `buildDesktopEntry()`（它同名、优先，会盖掉安装的那份 ——
 *      这是"换过图标的人静默失去深链接"那个坑的来源）。
 */
export const CHAT_PROTOCOL = 'whatsapp'

/** 系统的协议处理器交给我们时用的 scheme（`whatsapp://send?phone=…`）。 */
export const CHAT_SCHEME = `${CHAT_PROTOCOL}:`

/** 上游给"扫不出来就手输"的那条短链（`https://wa.me/<号码>`）。 */
const WA_ME_HOST = 'wa.me'

/**
 * 号码的形状：**E.164 的数字部分**。
 *
 * 下限 7 位：更短的几乎一定是误输入（或一个没带国家码的本地号码，而 `?phone=` 要求国际格式，
 * 收下它只会把用户送进一个"号码不存在"的页面）。上限 15 位：E.164 的规定。
 *
 * ⚠️ 另外拒绝**以 `0` 开头**的：国家码不会以 0 开头，而 `07700900123` 这种本地写法是最常见的
 * 误输入。它的坏法是安静的（页面会说"号码无效"，而用户以为是我们坏了），因此这里直接不认，
 * 并在主进程日志里留下那个原样的值。
 */
const MIN_PHONE_DIGITS = 7
const MAX_PHONE_DIGITS = 15

/**
 * 把号码拼成上游的对话 URL。
 *
 * `target` 允许是任意字符串（调用方可能刚拿到用户输入）：这里**只取数字**，因此拼出来的 URL
 * 结构上不可能被别的字符改掉。返回值之外没有第二个出口 —— 主窗口只会导航到它。
 */
export function chatUrl(target: string): string {
  return `${SEND_URL}?phone=${digitOnly(target)}`
}

/**
 * 从命令行参数里找出"要打开哪个对话"，返回 E.164 的数字部分（认不出来返回 `null`）。
 *
 * 认的三种输入，**优先** `--new-chat`（那是用户当场敲的那一个）：
 *
 *   1. `--new-chat <号码或链接>` 与 `--new-chat=<号码或链接>`；
 *   2. `whatsapp:` 协议的链接 —— 系统用协议处理器把 URL 当参数传进来时就是它；
 *   3. `https://wa.me/<号码>`（`wa.me/<号码>` 这种省了协议的写法也认）。
 *
 * 其余一律不认：`argv` 里塞满了 Chromium 自己的开关与启动路径，猜错的后果是"启动时莫名其妙
 * 打开了一个对话"。
 */
export function parseChatTarget(argv: readonly string[]): string | null {
  const value = chatValueFromArgv(argv)
  return value === null ? null : normalizeChatTarget(value)
}

/**
 * 上面那一步打算解释的**原样值**（`null` = 命令行里根本没有这一类参数）。
 *
 * 它只用于日志：`parseChatTarget` 返回 `null` 时，用户最需要知道的是"我们到底读到了什么"
 * —— 是号码格式不对，还是一个我们没见过的链接。**不记标题、不记会话名**这条纪律在这里自然
 * 满足（这个值本来就是用户自己写的）。
 */
export function chatValueFromArgv(argv: readonly string[]): string | null {
  const inline = argv.find((arg) => arg.startsWith(`${CHAT_ARG}=`))
  if (inline !== undefined) return inline.slice(CHAT_ARG.length + 1)

  const index = argv.indexOf(CHAT_ARG)
  if (index >= 0) return argv[index + 1] ?? null

  return argv.find((arg) => isChatLink(arg)) ?? null
}

/**
 * "号码或链接" → E.164 的数字部分。认不出来就是 `null`。
 *
 * 单独导出的理由：`--new-chat` 之外还有别的入口（将来可能的设置项、测试），而
 * "把用户输入变成一个安全的值"只应该有一份实现。
 */
export function normalizeChatTarget(value: string): string | null {
  const digits = extractPhone(value)
  return digits !== null && isPlausiblePhone(digits) ? digits : null
}

/**
 * 这是不是一个"要打开对话"的链接：`whatsapp:` 协议，或者 `wa.me` 上的链接。
 *
 * 只认这两个。**不要**顺手把 `api.whatsapp.com/send?phone=…` 加进来：那个 host 不在我们的
 * 上游域里（`shared/upstream.ts`），把它当成"站内链接"会让一个第三方可控的跳转页获得
 * "在应用里导航"的资格。
 */
export function isChatLink(rawUrl: string): boolean {
  const parsed = parseLink(rawUrl)
  if (parsed === null) return false

  if (parsed.protocol === CHAT_SCHEME) return true
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false

  return parsed.hostname.toLowerCase() === WA_ME_HOST
}

/**
 * 与 `shared/upstream.ts` 同形的解析入口。
 *
 * ⚠️ 用户写 `wa.me/8613…`（省掉协议）时浏览器与命令行都会照收，因此这里也认这一种写法 ——
 * 但**只**补 `wa.me` 那一种，别的（`+86 138…`、`whatsapp:…`）原样交给 `URL` 去判断：
 * 给任意字符串都补一个 `https://` 会让 `+86 138-0000-0000` 变成一个 host 为 `+86` 的 URL。
 */
function parseLink(value: string): URL | null {
  const trimmed = value.trim()
  const raw = trimmed.startsWith(`${WA_ME_HOST}/`) ? `https://${trimmed}` : trimmed

  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/** 从"号码或链接"里取出号码的数字部分（取不出来返回 `null`）。 */
function extractPhone(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null

  const parsed = parseLink(trimmed)

  if (parsed === null) {
    // 连一个 URL 都不像（`8613800000000`、`+86 138-0000-0000`）：按"用户直接写的号码"处理。
    return nonEmpty(digitOnly(trimmed))
  }

  // 像 URL：那就必须是"打开对话"的那两种形状之一，否则一律不认 —— 这里不能退回"把整串里的
  // 数字都取出来"，否则 `https://example.com/123` 会变成一个"给 123 发消息"的请求。
  if (!isChatLink(trimmed)) return null

  // `whatsapp://send?phone=…` 与 `wa.me/?phone=…` 把号码放在查询串里
  const query = parsed.searchParams.get('phone')
  if (query !== null) return nonEmpty(digitOnly(query))

  // `https://wa.me/<号码>` 把号码放在路径里（`/` 本身就等于"没给号码"）
  return nonEmpty(digitOnly(parsed.pathname.replace(/^\/+/, '')))
}

/** 只留数字。**唯一的**"清洗"动作，因此它必须是纯的、可被上面每一处复用。 */
function digitOnly(value: string): string {
  return value.replace(/\D+/g, '')
}

function nonEmpty(value: string): string | null {
  return value === '' ? null : value
}

function isPlausiblePhone(digits: string): boolean {
  return (
    digits.length >= MIN_PHONE_DIGITS &&
    digits.length <= MAX_PHONE_DIGITS &&
    !digits.startsWith('0')
  )
}
