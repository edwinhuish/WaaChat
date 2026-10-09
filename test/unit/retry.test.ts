/**
 * 重试策略的单测（[ADR-0033]）。
 *
 * 覆盖三件"改坏了没人会立刻发现"的事：
 *
 *   1. **哪些错误值得重试** —— 判据锁在实测形状上（fetch 失败抛出的 `Error` 只有 message 里
 *      带 `net::ERR_…`）。白名单放宽会把证书错误也变成"可重试"，收紧则会让网络抖动救不回来。
 *   2. **幂等方法才重试** —— 重试一个 `POST` 是重复提交，而"连接层失败"并不能保证请求没被
 *      对端处理过。
 *   3. **有上限、退避带抖动** —— 网络被整段阻断时不能把"加载中"变成"一直加载中"；而一次闪断
 *      会让几十个请求同时失败，抖动是为了不把它们挤在同一毫秒重试。
 *
 * fetch 与 sleep 都是注入的，因此这里不碰网络、也不等真实时间。
 */

import { describe, expect, it } from 'vitest'

import {
  MAX_ATTEMPTS,
  describeNetworkError,
  fetchWithRetry,
  isTransientNetworkError,
  nextDelayMs,
} from '../../src/main/capture/retry'

/** 实测形态：只有 message。 */
function netError(code: string): Error {
  return new Error(code)
}

function requestOf(method: string): Request {
  return new Request('https://media.example/x.enc', { method })
}

/** 前 `failures` 次失败、之后成功的假 fetch。 */
function flakyFetch(failures: number, code = 'net::ERR_CONNECTION_RESET') {
  let calls = 0

  return {
    get calls() {
      return calls
    },
    fetch: (): Promise<Response> => {
      calls += 1
      if (calls <= failures) return Promise.reject(netError(code))
      return Promise.resolve(new Response('ok', { status: 200 }))
    },
  }
}

describe('isTransientNetworkError', () => {
  it('认得出实测到的那两个连接层错误', () => {
    // 用户日志里的 net_error -101 就是第一个。
    expect(isTransientNetworkError(netError('net::ERR_CONNECTION_RESET'))).toBe(true)
    expect(isTransientNetworkError(netError('net::ERR_CONNECTION_CLOSED'))).toBe(true)
  })

  it('错误码后面还带别的文字时也认得出来', () => {
    expect(isTransientNetworkError(netError('net::ERR_CONNECTION_RESET: gave up'))).toBe(true)
  })

  it('证书问题不重试', () => {
    // 重试一百次结论也一样，而把它算成"可重试"会让真正的原因（中间人 / 证书）看起来像抖动。
    expect(isTransientNetworkError(netError('net::ERR_CERT_AUTHORITY_INVALID'))).toBe(false)
    expect(isTransientNetworkError(netError('net::ERR_CERT_DATE_INVALID'))).toBe(false)
  })

  it('主动取消、以及非网络错误都不重试', () => {
    expect(isTransientNetworkError(netError('net::ERR_ABORTED'))).toBe(false)
    expect(isTransientNetworkError(new TypeError('fetch failed'))).toBe(false)
    expect(isTransientNetworkError(null)).toBe(false)
    expect(isTransientNetworkError('不是错误对象')).toBe(false)
  })
})

describe('describeNetworkError', () => {
  it('只给错误码，不把完整消息（可能含 URL）带进日志', () => {
    expect(describeNetworkError(netError('net::ERR_CONNECTION_RESET'))).toBe(
      'net::ERR_CONNECTION_RESET',
    )
    expect(
      describeNetworkError(netError('net::ERR_CONNECTION_RESET 发生在 https://x/y?token=1')),
    ).toBe('net::ERR_CONNECTION_RESET')
  })

  it('非网络错误只给错误名', () => {
    expect(describeNetworkError(new TypeError('无法解析 https://x/y?token=1'))).toBe('TypeError')
  })
})

describe('fetchWithRetry', () => {
  it('首次失败、第二次成功时返回响应，并报告一次重试', async () => {
    const flaky = flakyFetch(1)
    const retries: unknown[] = []
    const delays: number[] = []

    const response = await fetchWithRetry(flaky.fetch, requestOf('GET'), {
      onRetry: (info) => retries.push(info),
      sleep: (ms) => {
        delays.push(ms)
        return Promise.resolve()
      },
    })

    expect(response.status).toBe(200)
    expect(flaky.calls).toBe(2)
    expect(retries).toHaveLength(1)
    expect(delays).toHaveLength(1)
  })

  it('POST 不重试：重复提交比一次失败严重', async () => {
    const flaky = flakyFetch(1)
    let gaveUp = 0

    await expect(
      fetchWithRetry(flaky.fetch, requestOf('POST'), {
        onRetry: () => {
          throw new Error('不该重试 POST')
        },
        onGaveUp: () => {
          gaveUp += 1
        },
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow('net::ERR_CONNECTION_RESET')

    expect(flaky.calls).toBe(1)
    // 它"试过一次就结束"，因此走的是放弃那条路 —— 调用方据此记一条日志。
    expect(gaveUp).toBe(1)
  })

  it('不值得重试的错误立刻抛出：不等、也不报放弃', async () => {
    const cert = flakyFetch(99, 'net::ERR_CERT_DATE_INVALID')
    let notified = 0

    await expect(
      fetchWithRetry(cert.fetch, requestOf('GET'), {
        onRetry: () => {
          notified += 1
        },
        onGaveUp: () => {
          notified += 1
        },
        sleep: () => {
          throw new Error('不该等待')
        },
      }),
    ).rejects.toThrow('net::ERR_CERT_DATE_INVALID')

    expect(cert.calls).toBe(1)
    expect(notified).toBe(0)
  })

  it('用尽尝试次数后抛出最后一次的错误，并报告放弃', async () => {
    const never = flakyFetch(99)
    let gaveUp: { attempt: number; limit: number } | null = null
    const delays: number[] = []

    await expect(
      fetchWithRetry(never.fetch, requestOf('GET'), {
        onGaveUp: (info) => {
          gaveUp = { attempt: info.attempt, limit: info.limit }
        },
        sleep: (ms) => {
          delays.push(ms)
          return Promise.resolve()
        },
      }),
    ).rejects.toThrow('net::ERR_CONNECTION_RESET')

    expect(never.calls).toBe(MAX_ATTEMPTS)
    expect(delays).toHaveLength(MAX_ATTEMPTS - 1)
    expect(gaveUp).toEqual({ attempt: MAX_ATTEMPTS, limit: MAX_ATTEMPTS })
  })
})

describe('nextDelayMs', () => {
  it('逐次变长，且都在上界之内', () => {
    // random() = 1 → 抖动取正向极值，因此这就是真实等待时间的上界。
    expect(nextDelayMs(1, () => 1)).toBeLessThanOrEqual(400)
    expect(nextDelayMs(2, () => 1)).toBeLessThanOrEqual(1200)
    expect(nextDelayMs(2, () => 1)).toBeGreaterThan(nextDelayMs(1, () => 1))
  })

  it('带抖动：同一档延迟不会总是同一个值', () => {
    // 一次闪断会让几十个请求同时失败；抖动是为了不让它们挤在同一毫秒重试。
    expect(nextDelayMs(1, () => 0)).not.toBe(nextDelayMs(1, () => 1))
    expect(nextDelayMs(1, () => 0)).toBeGreaterThan(0)
  })

  it('越界的 attempt 也能给出一个合法延迟（不会返回 undefined）', () => {
    expect(nextDelayMs(99, () => 1)).toBeGreaterThan(0)
  })
})
