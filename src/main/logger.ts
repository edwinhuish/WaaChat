/**
 * 日志。
 *
 * 这个模块承担一个**强制义务**：日志里不得出现文件名全文、会话名、消息内容、
 * 或绝对路径中的用户名段（INVARIANTS G-3，docs/security.md T4）。
 *
 * 原因很直接：日志会被贴进 issue、会被同步、会被别人读到。一条
 * `stored /home/edwin/客户合同-2026Q3.pdf` 就等于把通信内容和社交关系写进了公开渠道。
 *
 * 需要标识一份文件时，用 {@link hashPrefix}。
 *
 * ── 为什么这里**不**导入 electron ──
 *
 * 曾经它 `import { app } from 'electron'` 只为了读 `app.isPackaged` 决定日志级别。
 * 代价是：任何 import `logger` 的模块都连带把 Electron 运行时拉进来，于是
 * `archive/store.ts` 无法在单测里加载（`ai/CONVENTIONS.md` 第 8 节要求单测不加载
 * Electron），`scripts/check-capture.ts` 这种纯 Node 脚本也用不了日志。
 *
 * 改成把"是否打包"作为参数注入（{@link configureLogger}，由 `src/main/index.ts`
 * 在启动时调用）。少一个 import，换来整个 `archive/` 层可测、脚本可用 —— 值得。
 */

import { LOG_HASH_PREFIX_LENGTH } from '../shared/constants'

type Level = 'debug' | 'info' | 'error' | 'warn'

/**
 * 从 URL 里取出 host，供日志使用。
 *
 * 日志里允许出现 host，**不允许**出现完整 URL（[INVARIANTS G-1]：路径与查询串可能带签名与
 * 对象标识）。解析失败时返回空串 —— 绝不回退成"原样打印传进来的字符串"，那正好是这条纪律
 * 要防的事。
 */
export function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname
  } catch {
    return ''
  }
}

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function isLevel(value: string): value is Level {
  return value in LEVEL_ORDER
}

/** 显式指定过级别（环境变量或 {@link logger.setLevel}）之后，不再被自动推断覆盖。 */
let pinned = false

function fromEnvironment(): number | null {
  const raw = process.env['WAACHAT_LOG_LEVEL']
  return raw !== undefined && isLevel(raw) ? LEVEL_ORDER[raw] : null
}

const initial = fromEnvironment()
let threshold: number = initial ?? LEVEL_ORDER.debug
pinned = initial !== null

/**
 * 由主进程入口在启动时调用一次，把"是否打包"注入进来。
 *
 * 默认（未打包 / 未调用）是 `debug`：开发时少一条日志比多一条日志更让人烦躁。
 * 打包后是 `info`：普通用户不该被 debug 噪音淹没，而我们排查问题时拿到的
 * 用户日志里真正有用的是 info 以上。
 */
export function configureLogger(options: { readonly packaged: boolean }): void {
  if (pinned) return
  threshold = options.packaged ? LEVEL_ORDER.info : LEVEL_ORDER.debug
}

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return

  const suffix = fields === undefined ? '' : ` ${JSON.stringify(fields)}`
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${suffix}`

  if (level === 'error') process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => emit('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit('error', message, fields),

  /**
   * 强制指定级别（测试与 `--debug` 使用）。
   *
   * 一旦调用过，{@link configureLogger} 的自动推断就不再生效 —— 显式指定的意图
   * 优先于推断，否则"我明明设了 debug 却还是只有 info"这类问题会很难查。
   */
  setLevel(level: Level): void {
    pinned = true
    threshold = LEVEL_ORDER[level]
  },
}

/**
 * 把哈希截断成安全长度，用于日志中标识一份文件。
 *
 * 绝不要改成返回完整哈希或文件名 —— 日志脱敏是硬性要求，不是风格偏好。
 */
export function hashPrefix(hash: string): string {
  return hash.slice(0, LOG_HASH_PREFIX_LENGTH)
}

/**
 * 把绝对路径折叠成可安全记录的形式：只保留最后两段目录名之上的部分被抹掉。
 * 返回 `…/<父目录>/<文件名>` 形态，用于排查"文件是否存在"这类问题时保留一点上下文。
 *
 * 注意：**仍然包含文件名**，因此只允许在明确知道该文件不敏感时使用。
 * 绝大多数场合应该用 {@link hashPrefix}。
 */
export function redactPath(absolutePath: string): string {
  const parts = absolutePath.split('/').filter(Boolean)
  return parts.length <= 2 ? '…' : `…/${parts.slice(-2).join('/')}`
}
