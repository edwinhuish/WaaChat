/**
 * 连接层失败的有限重试（[ADR-0033]）。
 *
 * ── 为什么需要它 ──
 *
 * 网络抖动时，一次资源请求经常是"TLS 握手被重置"（`net_error -101` / `ERR_CONNECTION_RESET`，
 * Chromium 日志里的 `handshake failed; SSL error code 1` 就是它）。Chromium **不替调用方重试**
 * 这类失败：那一次请求直接失败，页面表现为资源加载不出来、媒体打不开。我们替**自己发起**的
 * 请求补试一次 —— 实测（见 [ADR-0033]）：首次连接被重置、第二次正常时，重试确实能把页面救回来。
 *
 * ── 三条边界，刻意写死在代码里而不是做成设置 ──
 *
 *   1. **只重试幂等方法**（{@link RETRYABLE_METHODS}）。`POST` / `PUT` 可能已经被对端处理过，
 *      而"连接层失败"并不能保证它没有 —— 重试等于重复提交。
 *   2. **只重试连接层的错误**（{@link TRANSIENT_NET_ERRORS}，白名单）。证书错误、4xx/5xx 重试
 *      不会改变结论，只会掩盖问题、拖慢失败。
 *   3. **有上限**（{@link MAX_ATTEMPTS}）。网络被整段阻断时（例如按 SNI 重置握手）重试必然也
 *      失败，有上限才不会把"加载中"变成"一直加载中"，并且留下一条"放弃"的日志。
 *
 * 本模块**不导入 electron**：fetch 与 sleep 都由调用方注入，因此重试逻辑本身可以单测
 * （"重试了几次、有没有碰不该碰的方法"都能断言），而不必真的去动网络。
 */

/** 可以安全重试的方法。其它方法一律只试一次。 */
const RETRYABLE_METHODS = new Set(['GET', 'HEAD'])

/**
 * 值得重试的连接层错误码。
 *
 * 判据来自**实测**：`net.fetch` / `ses.fetch` 失败时抛出的是 `Error`，只有 `message` 里带
 * `net::ERR_…`，没有 `code` / `errno` / `cause` 可用（见 [ADR-0033] 的实测表）。因此这里只能
 * 从 message 里取错误码，并且**刻意用白名单**：没列进来的一律当成"重试没有意义"。
 *
 * 黑名单写法的危险在于它把"新出现的错误"默认当成可重试 —— 而这里最需要保护的恰恰是未知
 * 情形（例如将来某个 `ERR_CERT_*` 变体）。
 */
const TRANSIENT_NET_ERRORS = new Set([
  /** 握手或传输中被重置 —— 用户日志里的 `net_error -101`。 */
  'net::ERR_CONNECTION_RESET',
  /** 对端在握手期间直接关闭（实测：服务器 accept 后立刻 destroy 报的就是这个）。 */
  'net::ERR_CONNECTION_CLOSED',
  /** 连接建立过程中被中断：Wi-Fi 切换、休眠唤醒、网线拔掉。 */
  'net::ERR_CONNECTION_ABORTED',
  'net::ERR_SOCKET_NOT_CONNECTED',
  /** 超时：拥塞时重来一次往往就通了。 */
  'net::ERR_TIMED_OUT',
  'net::ERR_CONNECTION_TIMED_OUT',
  /** 网络底层换了（换 Wi-Fi、拨号重连）—— 立刻重试用的是新链路。 */
  'net::ERR_NETWORK_CHANGED',
  /**
   * 少数受限网络用"篡改握手"代替重置，报出来就是协议错误。它可能是持久的（中间人），但有上限
   * 的重试不会让情况变坏，而抖动时能救回来。
   */
  'net::ERR_SSL_PROTOCOL_ERROR',
])

/**
 * 值不值得再试一次。
 *
 * ⚠️ 没列进来的错误**永远不重试**。特别地：`net::ERR_CERT_*`（证书问题重试一百次也一样）、
 * `net::ERR_ABORTED`（用户或页面主动取消）、以及任何非 `net::` 开头的错误（那是我们自己的 bug
 * 或 fetch 语义错误 —— 重试只会把它掩盖成"偶发"）。
 */
export function isTransientNetworkError(error: unknown): boolean {
  const code = netErrorCode(error)
  return code !== null && TRANSIENT_NET_ERRORS.has(code)
}

/**
 * 把错误压成一个可以安全写进日志的短字符串：`net::ERR_…` 原样返回，其它只给错误**名**。
 *
 * 刻意不返回完整 message：非网络错误的 message 里可能带完整 URL（[INVARIANTS G-3]）。
 * 而网络错误的 message 恰好就是错误码本身，所以这条规则不损失可诊断性。
 */
export function describeNetworkError(error: unknown): string {
  const code = netErrorCode(error)
  if (code !== null) return code

  return error instanceof Error ? error.name : typeof error
}

/**
 * 从消息里取出 `net::ERR_…`。
 *
 * 用"在字符串里找"而不是"整串相等"：Electron 在不同路径上会给出带后缀的版本
 * （实测见过 `net::ERR_CONNECTION_RESET` 单独一条）。取到的是**错误码本身**，因此白名单
 * 判据仍然只认真实存在的码。
 */
function netErrorCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const match = /net::ERR_[A-Z0-9_]+/.exec(message)

  return match === null ? null : match[0]
}

/** 总尝试次数：首次 + 重试。 */
export const MAX_ATTEMPTS = 3

/** 每次重试前等多久（毫秒）。第 3 次尝试之前用的是最后一项。 */
const RETRY_DELAYS_MS = [300, 900] as const

/** 上面那张表的兜底值，避免 `noUncheckedIndexedAccess` 下的 undefined。 */
const LAST_DELAY_MS = 900

/**
 * 抖动幅度：多个请求同时失败时（一次网络闪断会让几十个请求一起挂），不要在同一毫秒一起重试 ——
 * 那会把一次抖动变成一次小型的重试风暴。
 */
const JITTER_RATIO = 0.3

/**
 * 第 `attempt` 次重试之前应该等多久（`attempt` 从 1 开始）。
 *
 * `random` 可注入，因此单测能断言上下界，而不是"大概在几百毫秒"。
 */
export function nextDelayMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(attempt, 1), RETRY_DELAYS_MS.length) - 1
  const base = RETRY_DELAYS_MS[index] ?? LAST_DELAY_MS
  const jitter = 1 + (random() * 2 - 1) * JITTER_RATIO

  return Math.round(base * jitter)
}

/** 一次尝试失败后交给调用方的事实。 */
export interface RetryAttempt {
  /** 刚失败的是第几次尝试（从 1 开始）。 */
  readonly attempt: number
  /** 允许的总尝试次数。幂等请求是 {@link MAX_ATTEMPTS}，其它是 1（不重试）。 */
  readonly limit: number
  /** `net::ERR_…`；非网络错误时是错误名。 */
  readonly error: string
}

export interface RetryHooks {
  /** 决定再试一次时调用（调用方记一条日志）。 */
  readonly onRetry?: (info: RetryAttempt) => void
  /** 重试用尽、仍然失败时调用（调用方记一条"放弃"日志）。 */
  readonly onGaveUp?: (info: RetryAttempt) => void
  /** 测试注入用；默认用 `setTimeout`。 */
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * 发一次请求；失败在**值得重试**的前提下最多再试 {@link MAX_ATTEMPTS} − 1 次。
 *
 * @param fetchOnce 真正发包的函数。生产里是
 *   `ses.fetch(request, { bypassCustomProtocolHandlers: true })`
 * @param request 原始请求。实测：同一个 `Request` 对象可以重复交给 `ses.fetch`（[ADR-0033]），
 *   因此重试**不必**重建它 —— 也就不会在这条路径上引入"请求被改写"的可能。
 */
export async function fetchWithRetry(
  fetchOnce: (request: Request) => Promise<Response>,
  request: Request,
  hooks: RetryHooks = {},
): Promise<Response> {
  const sleep = hooks.sleep ?? defaultSleep
  const limit = RETRYABLE_METHODS.has(request.method.toUpperCase()) ? MAX_ATTEMPTS : 1

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetchOnce(request)
    } catch (error) {
      // 不值得重试的错误原样抛出：不等待、也不记"放弃"（它压根没被重试过）。
      if (!isTransientNetworkError(error)) throw error

      const info: RetryAttempt = { attempt, limit, error: describeNetworkError(error) }

      if (attempt >= limit) {
        hooks.onGaveUp?.(info)
        throw error
      }

      hooks.onRetry?.(info)
      await sleep(nextDelayMs(attempt))
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
