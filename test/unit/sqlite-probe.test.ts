/**
 * 原生模块探测自身的用例。
 *
 * 为什么要给一个"测试用的小工具"写用例：`test/helpers/sqlite.ts` 的存在意义是**识别一个
 * 无法被捕获的失败**（native 层崩溃）。它一旦被改回"本进程 require + try/catch"，这层保护
 * 就没了 —— 而症状要等到某次 CI 上 worker 被信号杀死、9 个 SQLite 用例静默消失时才会暴露，
 * 那时没人会想到是探测实现的问题。
 *
 * 因此这里用真实的子进程（真实的信号、真实的 MODULE_NOT_FOUND）把五条分支都钉住。
 * 探测脚本里的两个标记（`sqlite-probe:loaded` / `ready`）是"崩在哪一段"的唯一依据，
 * 也一并断言 —— 崩溃时 stdout 会被 `writeSync` 同步写出，否则标记会随进程一起丢。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runProbe } from '../helpers/sqlite'

/** 加载期崩溃：`require` 还没返回，进程就没了。 */
const CRASH_ON_LOAD = "process.kill(process.pid, 'SIGSEGV')\n"

/** 建库期崩溃：加载过了（标记已写出），死在 `new Database()` 里。 */
const CRASH_ON_OPEN = [
  'module.exports = function CrashingDatabase() {',
  "  process.kill(process.pid, 'SIGSEGV')",
  '}',
  '',
].join('\n')

/** 能加载、能"建库"，但执行 schema 时报错 —— 这不是环境问题，不该被跳过。 */
const BROKEN_SCHEMA_EXEC = [
  'module.exports = function FakeDatabase() {',
  '  return {',
  '    pragma() {},',
  "    exec() { throw new Error('boom: schema exec failed') },",
  '    prepare() { return { get() { return null } } },',
  '    close() {},',
  '  }',
  '}',
  '',
].join('\n')

const SCHEMA_PATH = fileURLToPath(new URL('../../src/main/archive/schema.sql', import.meta.url))
const REAL_ADDON = createRequire(import.meta.url).resolve('better-sqlite3')

/** Windows 上 `process.kill` 没有真实的信号语义，崩溃分支只在 POSIX 上可断言。 */
const windows = process.platform === 'win32'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'waachat-probe-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function fixture(name: string, source: string): string {
  const path = join(dir, name)
  writeFileSync(path, source)
  return path
}

describe('runProbe', () => {
  it('加载、建库、应用真实 schema 都成功时判定为可用', () => {
    const probe = runProbe({ addon: REAL_ADDON, schemaPath: SCHEMA_PATH })

    expect(probe.available).toBe(true)
  })

  it.skipIf(windows)('产物在加载阶段崩溃时判定为不可用，并指出崩在哪一段', () => {
    const probe = runProbe({
      addon: fixture('crash-on-load.js', CRASH_ON_LOAD),
      schemaPath: SCHEMA_PATH,
    })

    expect(probe.available).toBe(false)
    expect(probe.reason).toContain('SIGSEGV')
    expect(probe.reason).toContain('加载预编译产物')
  })

  it.skipIf(windows)('产物在建库阶段崩溃时给出不同的阶段说明', () => {
    const probe = runProbe({
      addon: fixture('crash-on-open.js', CRASH_ON_OPEN),
      schemaPath: SCHEMA_PATH,
    })

    expect(probe.available).toBe(false)
    expect(probe.reason).toContain('SIGSEGV')
    expect(probe.reason).toContain('打开数据库')
  })

  it('产物不存在时判定为不可用（与旧实现"加载失败就跳过"语义一致）', () => {
    const probe = runProbe({ addon: join(dir, 'not-installed.js'), schemaPath: SCHEMA_PATH })

    expect(probe.available).toBe(false)
    expect(probe.reason).toContain('加载失败')
  })

  it('加载成功但建库/schema 报错时**不**跳过：那是代码问题，要让用例红着报出来', () => {
    const probe = runProbe({
      addon: fixture('broken-exec.js', BROKEN_SCHEMA_EXEC),
      schemaPath: SCHEMA_PATH,
    })

    expect(probe.available).toBe(true)
    expect(probe.reason).toContain('建库时报错')
  })
})
