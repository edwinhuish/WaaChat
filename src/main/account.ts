/**
 * 账号标识：归档与密文两棵树的**第一层目录名**（[ADR-0039]）。
 *
 * ── 值从哪来：两级，先具体后兜底 ──
 *
 *   1. **页面记下的账号 WID**（`last-wid` / `last-wid-md`，落在分区的 Local Storage 里）。
 *      这是**账号级**的标识，而且认得出是谁（`18665597400`）—— 有它在，目录名就是可读的。
 *   2. 退一步用分区会话里的 **`wa_ul` cookie**（一个随机 UUID）。
 *      它是**浏览器 profile 级**的：换账号不变、重置 profile 就换一个。
 *   3. 都没有 → `unknown-account`（`paths.ts` 的回落值）。
 *
 * ⚠️ 两级都不是免费的：
 *
 *   - 第 1 级要**读页面自己写下的字节**（Chromium 的 Local Storage LevelDB）。我们只做
 *     "按已知键名取相邻的值"这一件事 —— 不解析存储格式、不做 LevelDB 解析器、更不碰密钥
 *     （同一个目录里躺着 `WAWebEncKeySalt` 这类键名，[INV-3] 的边界就在旁边）。
 *     上游换键名就取不到，那时**自动退到第 2 级**，而不是猜。
 *   - 第 2 级不表示账号：同一个 profile 里换账号不会换目录；profile 被重置会让归档分叉。
 *     两条限制都写在 [ADR-0039] 的"已知限制"里。
 *
 * ── 为什么单独一个文件 ──
 *
 * 它拿着一个 `Session`（因此只能待在能 import electron 类型的地方），而 `paths.ts` 刻意
 * 不导入 electron（单测与 `scripts/check-capture.ts` 要能直接用那个模块）。纯逻辑（净化在
 * `paths.ts`、键名查找与 WID 解析在下面）保持可单测：给一段合成的字节就能断言。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { Cookie, Session } from 'electron'

import { logger } from './logger'
import { setAccountKey } from './paths'

/** 承载账号标识的那条 cookie 的名字。 */
export const ACCOUNT_COOKIE_NAME = 'wa_ul'

/** 页面把它写在 `.web.whatsapp.com` 上。 */
const ACCOUNT_COOKIE_DOMAIN = 'web.whatsapp.com'

/**
 * 页面用来记"当前账号是谁"的 localStorage 键名，按优先级排。
 *
 * 上游改名字时这里**只会退到下一级**（cookie / 回落值），不会猜 —— 猜错的后果是"文件落进
 * 别人的目录"，比落进 `unknown-account` 糟得多。
 */
export const WID_STORAGE_KEYS = ['last-wid', 'last-wid-md'] as const

/**
 * 一个 WID 的形状：`<数字>[:<设备>]@<域>`。
 *
 * 用户部分是纯数字（`@lid` 那类也一样是数字），因此账号目录名就是它 —— 这正是
 * [ADR-0039] 想要的可读名字。不锚定整串：LevelDB 里键值相邻，取到的片段周围还有别的字节。
 */
const WID_PATTERN = /(?<!\d)([0-9]{6,16})(?::[0-9]{1,3})?@(?:c\.us|s\.whatsapp\.net|lid)/

/** 每个 Local Storage 文件最多读多少 —— 只是防着"库里混进一个大文件"，不是容量策略。 */
const MAX_STORAGE_FILE_BYTES = 8 * 1024 * 1024

/** 从一段文本里取账号标识（WID 的用户部分）；取不到返回 `null`。 */
export function accountKeyFromText(text: string): string | null {
  return WID_PATTERN.exec(text)?.[1] ?? null
}

/**
 * 在一段 Local Storage 字节里找键名后面的值，并解析出账号标识（纯函数，可单测）。
 *
 * 为什么两种编码都试：Chromium 里 localStorage 的键是 UTF-8，但值可以是 UTF-16LE
 * （首字节标记 `\x00`）或 Latin-1。上游戏把值写成哪种取决于内容，因此这里两个都解一遍，
 * 谁能解析出 WID 就用谁 —— 这比"猜它一定是哪一种"稳。
 *
 * 同一个文件里取**最后**一个命中：WAL 是追加写的，越靠后越新（用户换过账号时，
 * 旧值可能还在文件里）。
 */
export function extractAccountKeyFromBytes(bytes: Uint8Array): string | null {
  const latin = Buffer.from(bytes).toString('latin1')
  const utf16 = Buffer.from(bytes).toString('utf16le')

  let found: string | null = null

  for (const key of WID_STORAGE_KEYS) {
    for (const haystack of [latin, utf16]) {
      let from = 0

      for (;;) {
        const at = haystack.indexOf(key, from)
        if (at === -1) break

        // 值紧跟在键后面（Chromium 把键与值相邻写进数据块）。
        const parsed = accountKeyFromText(haystack.slice(at + key.length, at + key.length + 200))
        if (parsed !== null) found = parsed

        from = at + key.length
      }
    }
  }

  return found
}

/**
 * 从一批候选值里挑一个能用的账号标识（纯函数，可单测）。
 *
 * 规则很短：**第一个非空**的。不做"哪个更像 UUID"之类的挑选 —— 多值意味着页面换了写法，
 * 而那时宁可要一个稳定的、能当目录名的值，也不要一个会随上游细节变化的启发式。
 */
export function pickAccountKey(values: readonly string[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }

  return null
}

/**
 * 读一次页面记下的账号 WID（分区的 Local Storage）。
 *
 * 只读 `.log` / `.ldb` 这两个后缀，且逐个文件有大小上限；文件按**新→旧**扫，
 * 取第一个能解析出 WID 的（新写入在 `.log` 里，因此 `.log` 优先）。
 *
 * 读不到、读不了、或上游根本没写这个键 —— 一律返回 `null`，由调用方退到下一级。
 */
export function readAccountKeyFromStorage(ses: Session): string | null {
  const base = ses.getStoragePath()
  if (base === null) return null

  const dir = join(base, 'Local Storage', 'leveldb')

  let names: string[]
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith('.log') || name.endsWith('.ldb'))
      .sort((a, b) => {
        // `.log`（新写入）在前，其次按修改时间新的在前。
        const logOrder = Number(b.endsWith('.log')) - Number(a.endsWith('.log'))
        if (logOrder !== 0) return logOrder

        return mtime(join(dir, b)) - mtime(join(dir, a))
      })
  } catch {
    return null
  }

  for (const name of names) {
    const path = join(dir, name)

    try {
      if (statSync(path).size > MAX_STORAGE_FILE_BYTES) continue

      const key = extractAccountKeyFromBytes(readFileSync(path))
      if (key !== null) return key
    } catch {
      // 读不了这一个文件就试下一个：拿不到标识只是回到下一级，不该阻断启动。
      continue
    }
  }

  return null
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 解析账号标识并灌进 `paths`，返回最终生效的值。
 *
 * 顺序见文件头：**页面记下的 WID → `wa_ul` cookie → 回落值**。失败**不是错误**：
 * 归档写入不受影响 —— 位置是 `stored_name` 记着的事实（[ADR-0037]）。
 *
 * 应在 `whenReady` 里、**早于**会话配置与任何窗口创建时调用一次（[ADR-0039]）。
 */
export async function resolveAccountKey(ses: Session): Promise<string> {
  const fromStorage = readAccountKeyFromStorage(ses)
  if (fromStorage !== null) {
    const key = setAccountKey(fromStorage)
    // ⚠️ 只记"从哪一级拿到的"，不记那个值：它是标识用户的东西（INVARIANTS G-3）。
    logger.info('account: directory layer resolved', { identified: true, source: 'wid' })

    return key
  }

  let cookies: Cookie[]
  try {
    cookies = await ses.cookies.get({
      name: ACCOUNT_COOKIE_NAME,
      domain: ACCOUNT_COOKIE_DOMAIN,
    })
  } catch (error) {
    logger.warn('account: could not read the account cookie', { reason: (error as Error).name })
    return setAccountKey(null)
  }

  const picked = pickAccountKey(cookies.map((cookie) => cookie.value))
  const key = setAccountKey(picked)

  logger.info('account: directory layer resolved', {
    identified: picked !== null,
    source: 'cookie',
  })

  return key
}
