/**
 * 归档索引的单测。
 *
 * 覆盖三件容易悄悄坏掉的事：
 *
 *   1. 同一个 (hash, name) 重复打开时**更新**时间，而不是新增一行
 *      （否则用户每点一次同一个文件，搜索里就多一条重复条目）
 *   2. 中文子串搜索能命中（trigram 分词器的存在理由）
 *   3. 短查询回退到 LIKE（trigram 要求 >= 3 字符，不回退就会"搜两个字返回空"）
 *
 * 这个文件能在不加载 Electron 的前提下跑，依赖一个条件：`archive/` 整层都不导入
 * electron。曾经 `logger` 为了读 `app.isPackaged` 而导入它，连带把整层拖住；现在
 * 打包状态是注入的（见 `src/main/logger.ts` 的说明）。**不要重新引入那条依赖。**
 *
 * ⚠️ `better-sqlite3` 是 Node-API 模块，Node 与 Electron 共用同一份二进制，所以这些用例
 * 在普通 `pnpm run test` 下就会真正执行。只有在 N-API 二进制缺失、当前平台不受支持、或
 * 加载它会让进程**崩溃**（预编译产物与本机 libc/CPU 不匹配）时才会跳过，原因见
 * `test/helpers/sqlite.ts` —— 探测在**子进程**里跑，正是为了能识别最后那种情况。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 类型导入会被编译期擦除，因此这一行**不会**在模块加载时拉起 better-sqlite3。
import type { ArchiveStore } from '../../src/main/archive/store'
import { setArchiveDir } from '../../src/main/paths'
import { probeSqlite } from '../helpers/sqlite'

const probe = probeSqlite()
const available = probe.available

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'waachat-store-'))

  // 归档统计（store.stats）会去数**当前生效**的归档目录，而它现在默认落在用户的
  // 文档目录下（ADR-0018）—— 不挡开的话，测试结果会取决于开发者本机有多少文件。
  setArchiveDir(join(root, 'media'))
})

afterAll(() => {
  // 复位模块级状态：同一个进程里的其它用例不该继承这个临时目录。
  setArchiveDir('')

  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!available)('ArchiveStore', () => {
  let instance: ArchiveStore | null = null

  beforeAll(async () => {
    // 动态导入：静态导入会在模块加载期就去加载原生模块，"跳过"的判断来不及生效。
    const module = await import('../../src/main/archive/store')
    instance = new module.ArchiveStore(join(root, 'index.sqlite'))
  })

  afterAll(() => {
    // `instance` 可能还是 null（beforeAll 失败时）。清理必须容忍这一点 ——
    // 否则真正的失败会被一个 "Cannot read properties of null" 盖住。
    instance?.close()
  })

  /**
   * 已初始化的 store。
   *
   * 用访问器而不是非空断言：断言失败时抛出的是"未初始化"这个**原因**，
   * 而不是每个用例各自报一个 TypeError。
   */
  function store(): ArchiveStore {
    if (instance === null) throw new Error('ArchiveStore 未初始化（beforeAll 未成功执行）')
    return instance
  }

  it('记录后可读回，字段完整', () => {
    const record = store().record({
      hash: 'a'.repeat(64),
      name: '报告.pdf',
      bytes: 1234,
      mime: 'application/pdf',
      openedAt: 1_700_000_000_000,
    })

    expect(record.id).toBeGreaterThan(0)
    expect(store().byId(record.id)).toEqual(record)
    expect(store().byHash('a'.repeat(64))).toHaveLength(1)
  })

  it('同一份内容多次打开只更新打开时间', () => {
    const base = { hash: 'b'.repeat(64), name: '合同.pdf', bytes: 10, mime: 'application/pdf' }

    const first = store().record({ ...base, openedAt: 1_000 })
    const second = store().record({ ...base, openedAt: 2_000 })

    expect(second.id).toBe(first.id)
    expect(second.openedAt).toBe(2_000)
    expect(store().byHash(base.hash)).toHaveLength(1)
  })

  it('文件名不同则视为两条记录（同一份内容被转发）', () => {
    const hash = 'c'.repeat(64)
    store().record({ hash, name: 'v1.pdf', bytes: 1, mime: '', openedAt: 1_000 })
    store().record({ hash, name: 'v2.pdf', bytes: 1, mime: '', openedAt: 2_000 })

    expect(store().byHash(hash)).toHaveLength(2)
  })

  it('中文子串搜索命中（trigram）', () => {
    store().record({
      hash: 'd'.repeat(64),
      name: '2026年第三季度采购合同.pdf',
      bytes: 1,
      mime: '',
      openedAt: 3_000,
    })

    // 4 个字符，走 FTS5 的 trigram 路径。子串命中是它与 unicode61 的关键差别：
    // unicode61 会把整串中文当成一个 token，于是"搜子串"完全失效。
    const hits = store().list({ text: '第三季度' })

    expect(hits.map((item) => item.name)).toContain('2026年第三季度采购合同.pdf')
  })

  it('短查询回退到 LIKE', () => {
    // trigram 要求 >= 3 个字符；不回退的话"搜两个字"会返回空，看起来像坏了。
    const hits = store().list({ text: '合同' })

    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((item) => item.name.includes('合同'))).toBe(true)
  })

  it('查询串里的 FTS 特殊字符不会让查询抛错', () => {
    // 未转义的话 `MATCH` 会抛语法错误，而不是返回空 —— 那是"搜索框输入引号就崩"。
    expect(() => store().list({ text: '报告" AND "' })).not.toThrow()
    expect(() => store().list({ text: '100%_off' })).not.toThrow()
  })

  it('按时间倒序返回', () => {
    const times = store()
      .list({ limit: 100 })
      .map((item) => item.openedAt)

    expect(times).toEqual([...times].sort((a, b) => b - a))
  })

  it('删除哈希时同步清掉全文索引', () => {
    const hash = 'e'.repeat(64)
    store().record({ hash, name: '待删除-独特词-zzz.pdf', bytes: 1, mime: '', openedAt: 4_000 })

    const removed = store().deleteByHashes([hash])

    expect(removed).toBe(1)
    // 索引没同步的症状是"搜得到但记录已不存在"——悬空记录比漏搜更难查。
    expect(store().list({ text: '独特词' })).toHaveLength(0)
  })

  it('删除不存在的哈希返回 0 而不是抛错', () => {
    expect(store().deleteByHashes(['f'.repeat(64)])).toBe(0)
    expect(store().deleteByHashes([])).toBe(0)
  })
})

describe.skipIf(available)('ArchiveStore（跳过）', () => {
  it(probe.reason, () => {
    // 这条用例存在的唯一目的是让"为什么跳过了"出现在测试输出里，
    // 而不是留下一个没有解释的 skip 标记：原因里包含崩在哪一段与什么信号。
    expect(available).toBe(false)
  })
})
