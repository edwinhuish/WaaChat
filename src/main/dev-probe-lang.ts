/**
 * 开发模式：只读观察网页版那条**界面语言偏好** cookie 在做什么。
 *
 * ⚠️ **我们不再写它**（[ADR-0066] 撤掉了「界面语言」这一项）：登录之后语言由**账号**决定，
 * 我们做的任何固定都会被页面改回去（`docs/research/lang-preference.md` §4.5）。这条探针留下，
 * 是因为它是"上游什么时候动这条 cookie、有没有哪天开始提供网页端语言开关"的**唯一**直接耳目 ——
 * 观察不等于能改，而"上游改版了我们不知道"正是这个仓库最讨厌的那类静默变化。
 *
 * 回答的问题（`docs/research/lang-preference.md`）：
 *
 *   - 那条 cookie 被改了几次、什么时候、`cause` 是什么？
 *   - 有没有**网络响应**在写它（`Set-Cookie`）？⚠️ 这一条才是"形态 A 还是形态 B"的判据：
 *     `cause` **分不出**我们自己的 `cookies.set()` 与页面的写入（实测两者打出来是同一组
 *     `overwrite` + `inserted`，见 §4.5 判据二）。
 *   - 它带不带 `HttpOnly` —— 带了就排除了"页面脚本写的"（脚本写不出 HttpOnly）。
 *
 * ── 与 [INV-1] 的关系 ──────────────────────────────────────────────────────
 *
 * 这一切都发生在**会话 / 网络层**，不在页面里跑任何脚本：`onHeadersReceived` 这一处只**看**、
 * 只 `callback({})` 放行，一个字节都不改 —— 与 `capture/request-context.ts` 观察请求角色是
 * 同一个做法（那次也是"只读：`callback({})` 放行，不改一个字节"）。
 * 页面里那一半是 `test/fixtures/probe-lang-pref.js`（[ADR-0057] 的只读元数据例外）。
 *
 * ⚠️ **不要**在这里注册 `onBeforeRequest`：那个事件被密文缓存层占着（`capture/protocol.ts`，
 * 而且它摘掉时会 `onBeforeRequest(null)`）—— 再注册一个会把它的观察者**顶掉**，症状是
 * "缓存命中时请求角色丢了"这种极难定位的问题。`onHeadersReceived` 目前没人用，因此安全。
 *
 * ⚠️ 与媒体探针一样**只在未打包时**生效：产物里不该有这段行为。
 *
 * ── 日志纪律（`docs/security.md`）──────────────────────────────────────────
 *
 * cookie 值**可能是凭据**，因此只有"看起来就是语言码"的值才原样打出来，其余一律只报长度；
 * 地址只报 `origin + pathname`（query 里可能有凭据）。
 */

import { app, type Cookie, type Session } from 'electron'

import { PAGE_LANGUAGE_COOKIE, isLanguageCode } from '../shared/language'
import { isUpstreamOrigin } from '../shared/upstream'
import { failureReason } from './errors'
import { logger } from './logger'

/**
 * 被观察的那条 cookie 是**上游自己的**名字（实测，`docs/research/lang-preference.md` §4.4）：
 * 常量与"看起来就是语言码"那条判据都在 `shared/language.ts`。
 *
 * ⚠️ 它原来就写在这个文件里，理由是"[ADR-0066] 之后 `src/` 里没有任何地方会去写它，因此探针是
 * 唯一该提到它的地方"。那个前提今天不成立了 —— [ADR-0088] 之后 `main/page-language.ts` **读**
 * 同一个名字（只读，一个字节都不写）。两处各写一份的话，名字一改，探针会**静默地**什么都不观察，
 * 而它正是我们看清上游何时改版的唯一眼睛。因此那条判据与那个名字都只有一份。
 *
 * ⚠️ `isLanguageCode()` 与 `test/fixtures/probe-lang-pref.js` 里同名的那一条**必须一致**
 * （夹具不能 `import`，只能各写一份）：判据不同就会出现"主进程打了、页面没打"这种对不上的报告
 * —— **改一处记得改另一处**。
 */

/** 值 → 可打印的形状。**只有语言码原样报出**，其余一律只报长度。 */
function safeValue(value: string): string {
  return isLanguageCode(value) ? value : `len=${value.length}`
}

/** 一条 cookie 里可以进日志的那部分（没有值，除非它看起来就是语言码）。 */
function describeCookie(cookie: Cookie): Record<string, unknown> {
  return {
    domain: cookie.domain,
    path: cookie.path,
    value: safeValue(cookie.value),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    session: cookie.session,
    sameSite: cookie.sameSite,
  }
}

/** 只报 `origin + pathname`：query 里可能有凭据（同 `logger` 的脱敏约定）。 */
function safeLocation(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return '(unparsable url)'
  }
}

/** 一个 `Set-Cookie` 行里**我们只关心属性在不在**，不关心它的值（`SameSite` 除外）。 */
function attributesOf(line: string): Record<string, unknown> {
  const sameSite = /;\s*samesite=([^;]+)/i.exec(line)?.[1]

  return {
    httpOnly: /;\s*httponly/i.test(line),
    secure: /;\s*secure/i.test(line),
    sameSite: sameSite?.trim() ?? null,
    maxAge: /;\s*max-age=/i.test(line),
    expires: /;\s*expires=/i.test(line),
    domain: /;\s*domain=([^;]+)/i.exec(line)?.[1]?.trim() ?? null,
    path: /;\s*path=([^;]+)/i.exec(line)?.[1]?.trim() ?? null,
  }
}

/** 这一行 `Set-Cookie` 是不是在写我们关心的那条 cookie。 */
function writesCookie(line: string, name: string): boolean {
  return new RegExp(`^\\s*${name}=`).test(line)
}

/** `responseHeaders` 的键大小写由内核决定 —— 两种都收。 */
function setCookieLines(headers: Record<string, string[]>): string[] {
  const lines: string[] = []

  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'set-cookie') continue
    lines.push(...values)
  }

  return lines
}

/** 每个会话只装一次（`configureSession` 之外还有别的调用点时会重复挂监听器）。 */
let watching = false

/**
 * 把观察者挂到会话上。
 *
 * 必须在**创建任何窗口之前**调用：要看到页面第一次请求的响应头。
 * 与 `attachDevProbe()` 一样，调用方**不需要**判断是否打包。
 */
export function attachLangProbeSession(ses: Session): void {
  if (app.isPackaged) return
  if (watching) return

  watching = true

  /**
   * cookie 的每一次变化。
   *
   * ⚠️ `cause` **不是**"谁写的"的判据：实测里我们自己的 `cookies.set()` 与页面的写入打出来是
   * **同一组** `overwrite` + `inserted`，而 `explicit` 一次都没出现过（§4.5 判据二）。
   * 因此这里只把它当**线索**记下来，判据看下面那条 `Set-Cookie` 的观察。
   */
  ses.cookies.on('changed', (_event, cookie, cause, removed) => {
    if (cookie.name !== PAGE_LANGUAGE_COOKIE) return

    logger.info('lang probe: cookie changed', {
      cause,
      removed,
      ...describeCookie(cookie),
    })
  })

  /**
   * 响应头里的 `Set-Cookie` —— "服务端有没有发它"的**直接**证据（比看 cookie 变化的 cause 更直白）。
   *
   * 只在**首次**见到某个地址时报一条：同一份响应会反复出现，每次都打会把真正有用的那几行埋掉。
   */
  const reported = new Set<string>()

  ses.webRequest.onHeadersReceived((details, callback) => {
    try {
      if (isUpstreamOrigin(details.url)) {
        for (const line of setCookieLines(details.responseHeaders ?? {})) {
          if (!writesCookie(line, PAGE_LANGUAGE_COOKIE)) continue

          const where = safeLocation(details.url)
          if (reported.has(where)) break

          reported.add(where)
          logger.info('lang probe: a response carries the language cookie', {
            where,
            attributes: attributesOf(line),
          })
          break
        }
      }
    } catch (error) {
      /**
       * 观察失败**不能**把请求卡住：`callback` 必须被调用（这也是为什么整段都在 `try` 里）。
       */
      logger.warn('lang probe: could not inspect the response headers', {
        reason: failureReason(error),
      })
    }

    callback({})
  })

  logger.info('lang probe: watching the language cookie (dev only)', {
    cookie: PAGE_LANGUAGE_COOKIE,
  })

  void readLangCookies(ses)
}

/**
 * 启动时先看一眼现有的那条 cookie（它是上次运行留下的，因此**不一定**是本次谁会写的形状）。
 *
 * 读不到不是错误：全新 profile 里它本来就不存在 —— 那也是一条有用的信息（"它由页面访问创建"）。
 */
async function readLangCookies(ses: Session): Promise<void> {
  try {
    const cookies = await ses.cookies.get({ name: PAGE_LANGUAGE_COOKIE })

    logger.info('lang probe: the language cookie as it stands now', {
      count: cookies.length,
      cookies: cookies.map(describeCookie),
    })

    if (cookies.length === 0) {
      logger.info('lang probe: no such cookie yet — it appears once the page talks to the server')
    }
  } catch (error) {
    logger.warn('lang probe: could not read the language cookie', { reason: failureReason(error) })
  }
}
