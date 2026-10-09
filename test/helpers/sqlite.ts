/**
 * 测试用的原生模块探测。
 *
 * `better-sqlite3` 13.x 是 **Node-API（N-API）** 模块，ABI 稳定：同一份
 * `prebuilds/<平台>-<架构>.node` 在 Node 与 Electron 里都能加载。实测：
 *
 *   node -e "require('better-sqlite3')"                              → ABI 127 ✓
 *   ELECTRON_RUN_AS_NODE=1 electron -e "require('better-sqlite3')"   → ABI 149 ✓
 *
 * 所以**不存在**「postinstall 按 Electron ABI 重建之后 Node 就跑不了」的问题，
 * `electron-builder install-app-deps` 在本项目当前依赖上实际是 no-op。
 *
 * 那为什么还探测？因为这个结论依赖两个前提：① 依赖仍是 N-API；② 当前平台在
 * `prebuilds/` 里有对应二进制（否则要本地从源码构建，而构建可能因缺工具链失败）。
 * 任一条不成立时探测返回 false。
 *
 * ---
 *
 * ⚠️ **探测必须在子进程里跑**（本文件早期版本是在本进程里 `require` + try/catch）。
 *
 * native 模块的失败方式不止"抛错"一种：预编译产物与本机 libc / CPU 指令集 / 依赖的
 * 动态库不匹配时，表现可能是**直接崩溃**（SIGSEGV / SIGILL）。信号抓不住，于是：
 *
 *   - 整个 worker 消失，vitest 只能报一句 `Worker forks emitted error`，指不出原因；
 *   - 那一轮的 9 个 SQLite 用例**静默**少跑（`42 passed` 变成 `33 passed`），与
 *     "少写了几个用例"在输出上无法区分。
 *
 * （实测过：`Worker exited unexpectedly with signal SIGSEGV ... while running test file
 * test/unit/store.test.ts`，本地三个 Node 版本都复现不了，是运行环境侧的 native 崩溃。）
 *
 * 放进子进程后，崩溃变成一次可读的返回值。因此用例**探测一次、跑不了就跳过**，并让
 * 原因出现在测试输出里 —— 让整套单测变红会训练出"红了先看一眼是不是老问题"的习惯，
 * 那比没有测试更糟。
 *
 * 探测分三段，子进程用 `sqlite-probe:<阶段>` 同步写标记（`writeSync`：崩溃时管道里
 * 排队的输出会丢，同步写不会），这样跳过原因能指出**崩在哪一段**：
 *
 *   1. 加载预编译产物；
 *   2. 打开数据库（WAL）；
 *   3. 执行真实 schema（`src/main/archive/schema.sql`，含 FTS5 trigram 分词器）。
 *
 * ⚠️ 第 2、3 段**普通报错**不算"环境不支持"：那是依赖或代码的问题，必须让真正的用例
 * 红着报出来（FTS5 被裁掉时跳过，会把"归档搜索全坏"藏起来）。只有**崩溃**与
 * **加载失败**才跳过。
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export interface SqliteProbe {
  /** `true` = 执行 SQLite 相关用例；`false` = 跳过（原因见 `reason`）。 */
  readonly available: boolean
  /** 跳过原因。被写成跳过用例的名字，因此直接出现在测试输出里。 */
  readonly reason: string
}

/** 正常在几十毫秒内结束。卡住说明环境有问题，别让它拖住整轮单测。 */
const PROBE_TIMEOUT_MS = 30_000

const SCHEMA_PATH = fileURLToPath(new URL('../../src/main/archive/schema.sql', import.meta.url))

/**
 * 子进程里跑的探测脚本。
 *
 * 写成字符串而不是独立文件：它必须在**裸 Node** 里执行（不经 vitest 的 transform），
 * 而 `test/**` 下只有 `.ts` 拿到了 Node globals（见 eslint.config.mjs 的 NODE_SIDE）——
 * 为一个十几行的脚本新增一个文件加一处 lint 配置不划算。
 *
 * `process.argv[1]` 是待加载的产物，`process.argv[2]` 是 schema。
 */
const PROBE_SCRIPT = [
  "const writeSync = require('node:fs').writeSync",
  "const mark = (stage) => writeSync(1, 'sqlite-probe:' + stage + '\\n')",
  'const Database = require(process.argv[1])',
  "mark('loaded')",
  "const { mkdtempSync, readFileSync, rmSync } = require('node:fs')",
  "const { join } = require('node:path')",
  "const { tmpdir } = require('node:os')",
  "const dir = mkdtempSync(join(tmpdir(), 'sqlite-probe-'))",
  'try {',
  "  const db = new Database(join(dir, 'probe.sqlite'))",
  "  db.pragma('journal_mode = WAL')",
  "  db.exec(readFileSync(process.argv[2], 'utf8'))",
  "  db.prepare('SELECT count(*) AS n FROM files').get()",
  '  db.close()',
  "  mark('ready')",
  '} finally {',
  '  rmSync(dir, { recursive: true, force: true })',
  '}',
].join('\n')

let cached: SqliteProbe | null = null

/** 探测本机能否跑 SQLite 相关用例。结果按进程缓存（每个测试文件一个进程）。 */
export function probeSqlite(): SqliteProbe {
  if (cached !== null) return cached

  const addon = resolveAddon()
  cached =
    addon === null
      ? {
          available: false,
          reason:
            'better-sqlite3 未安装或无法解析（N-API 二进制缺失）—— SQLite 索引相关用例本次未覆盖',
        }
      : runProbe({ addon, schemaPath: SCHEMA_PATH })

  if (!cached.available) {
    // 跳过必须**可见**（ai/CONVENTIONS.md 第 4 节）。默认 reporter 不打印被跳过用例的名字，
    // 不留这一行的话 CI 日志里就只剩一句 `9 skipped`，等于把"这次没覆盖 SQLite"藏起来。
    console.warn(`[sqlite] ${cached.reason}`)
  }

  return cached
}

/**
 * 探测一次。`options` 暴露出来只为让 `test/unit/sqlite-probe.test.ts` 能注入别的
 * "产物"来钉住崩溃分支 —— 生产路径请用 `probeSqlite()`。
 *
 * @internal
 */
export function runProbe(options: { addon: string; schemaPath: string }): SqliteProbe {
  const result = spawnSync(
    process.execPath,
    ['-e', PROBE_SCRIPT, options.addon, options.schemaPath],
    {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    },
  )

  // 子进程连退出码都没拿到（超时、资源受限、受限沙箱）。这种情况没有可靠信息可用，
  // 只能跳过并说明原因 —— 但绝不在本进程里再试一次：那正是要避免的崩溃路径。
  if (result.error !== undefined) {
    return {
      available: false,
      reason: `better-sqlite3 探测进程未能正常结束（${result.error.message}）—— SQLite 索引相关用例本次未覆盖`,
    }
  }

  const stdout = result.stdout ?? ''
  const loaded = stdout.includes('sqlite-probe:loaded')
  const stage = loaded ? '打开数据库 / 应用 schema' : '加载预编译产物'

  if (result.signal !== null) {
    return {
      available: false,
      reason:
        `better-sqlite3 在「${stage}」阶段让进程崩溃（信号 ${result.signal}），而不是抛错 —— ` +
        'SQLite 索引相关用例本次未覆盖。这通常意味着预编译产物与本机环境不匹配' +
        '（libc / CPU 指令集 / 缺动态库），可用 `node -e "require(\'better-sqlite3\')"` 复核',
    }
  }

  if (result.status === 0) {
    return {
      available: true,
      reason: 'better-sqlite3 可用：已加载、建库并应用过真实 schema',
    }
  }

  const detail = lastLine(result.stderr ?? '')

  // 连 `loaded` 标记都没打出来 ⇒ 加载阶段就失败了（二进制缺失、平台不支持、dlopen 报错）。
  // 这是环境问题，与旧实现"加载不了就跳过"的语义一致。
  if (!loaded) {
    return {
      available: false,
      reason: `better-sqlite3 加载失败（N-API 二进制缺失或平台不支持）：${detail} —— SQLite 索引相关用例本次未覆盖`,
    }
  }

  // 加载过了，报错发生在建库 / schema 阶段 ⇒ 不是环境问题，交给真正的用例去红。
  return {
    available: true,
    reason: `better-sqlite3 可加载，但探测建库时报错（${detail}）—— 交由 SQLite 用例自己报告`,
  }
}

/** 解析产物路径。`require.resolve` 只解析、不加载，因此这条路本身不会崩。 */
function resolveAddon(): string | null {
  try {
    return createRequire(import.meta.url).resolve('better-sqlite3')
  } catch {
    return null
  }
}

function lastLine(text: string): string {
  const lines = text.trim().split('\n')
  return lines[lines.length - 1] ?? ''
}
