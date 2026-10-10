/**
 * 归档索引的单测。
 *
 * 覆盖四件容易悄悄坏掉的事：
 *
 *   1. 同一个 (hash, name) 重复打开时**更新**时间，而不是新增一行
 *      （否则用户每点一次同一个文件，搜索里就多一条重复条目）
 *   2. 中文子串搜索能命中（trigram 分词器的存在理由）
 *   3. 短查询回退到 LIKE（trigram 要求 >= 3 字符，不回退就会"搜两个字返回空"）
 *   4. 旧库能补上 `stored_name` 列，且旧记录（那一列为空）读回来回落到哈希名
 *      （[ADR-0031]：正文改用原文名之后，旧归档里的哈希名文件必须仍然打得开）
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

import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// 类型导入会被编译期擦除，因此这一行**不会**在模块加载时拉起 better-sqlite3。
import type { ArchiveStore } from '../../src/main/archive/store'
import type { ArchiveRecord } from '../../src/shared/types'
import { archiveFilePath, ensureArchiveDir, usage } from '../../src/main/archive/blobs'
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

  /**
   * 构造一条记录。
   *
   * `storedName`（磁盘上的实际文件名）在真实路径里由 `commitFromTemp()` 给出；这些用例只关心
   * 索引行为，因此统一填成与 `name` 相同 —— 磁盘名在 [ADR-0031] 之后默认就是原文名，只有
   * 同名冲突时才会多一段哈希后缀。
   */
  function entry(fields: {
    hash: string
    name: string
    storedName?: string
    bytes?: number
    mime?: string
    openedAt: number
  }): Omit<ArchiveRecord, 'id'> {
    return {
      bytes: 0,
      mime: '',
      ...fields,
      storedName: fields.storedName ?? fields.name,
    }
  }

  it('记录后可读回，字段完整', () => {
    const record = store().record(
      entry({
        hash: 'a'.repeat(64),
        name: '报告.pdf',
        bytes: 1234,
        mime: 'application/pdf',
        openedAt: 1_700_000_000_000,
      }),
    )

    expect(record.id).toBeGreaterThan(0)
    expect(record.storedName).toBe('报告.pdf')
    expect(store().byId(record.id)).toEqual(record)
    expect(store().byHash('a'.repeat(64))).toHaveLength(1)
  })

  it('同一份内容多次打开只更新打开时间', () => {
    const base = { hash: 'b'.repeat(64), name: '合同.pdf', bytes: 10, mime: 'application/pdf' }

    const first = store().record(entry({ ...base, openedAt: 1_000 }))
    const second = store().record(entry({ ...base, openedAt: 2_000 }))

    expect(second.id).toBe(first.id)
    expect(second.openedAt).toBe(2_000)
    expect(store().byHash(base.hash)).toHaveLength(1)
  })

  it('磁盘名变了时跟着更新（否则会"搜得到但打不开"）', () => {
    const base = { hash: 'b2'.repeat(32), name: '报价单.pdf', bytes: 10, mime: '' }
    const first = store().record(entry({ ...base, openedAt: 1_000 }))

    // 同名冲突让磁盘上的名字换了候选（ADR-0031），索引必须跟着走。
    const second = store().record(
      entry({ ...base, storedName: '报价单 (a1b2c3d4).pdf', openedAt: 2_000 }),
    )

    expect(second.id).toBe(first.id)
    expect(second.storedName).toBe('报价单 (a1b2c3d4).pdf')
  })

  it('文件名不同则视为两条记录（同一份内容被转发）', () => {
    const hash = 'c'.repeat(64)
    store().record(entry({ hash, name: 'v1.pdf', bytes: 1, mime: '', openedAt: 1_000 }))
    store().record(entry({ hash, name: 'v2.pdf', bytes: 1, mime: '', openedAt: 2_000 }))

    expect(store().byHash(hash)).toHaveLength(2)
  })

  it('同一份内容在不同会话目录里各留一条记录（磁盘上是硬链接，[ADR-0052] / [ADR-0055]）', () => {
    const hash = 'c2'.repeat(32)

    store().record(
      entry({
        hash,
        name: '合同.pdf',
        storedName: 'acc/111@c.us/files/合同.pdf',
        bytes: 1,
        mime: '',
        openedAt: 1_000,
      }),
    )
    store().record(
      entry({
        hash,
        name: '合同.pdf',
        storedName: 'acc/222@c.us/files/合同.pdf',
        bytes: 1,
        mime: '',
        openedAt: 2_000,
      }),
    )

    // 判重键里的"容器"（哪个会话）不同 ⇒ 两条记录，否则其中一条路径会变成没人认识的孤儿。
    expect(store().byHash(hash)).toHaveLength(2)
  })

  it('同一个会话里磁盘名换了候选时更新同一行，而不是多一条重复记录', () => {
    const hash = 'c3'.repeat(32)

    const first = store().record(
      entry({
        hash,
        name: '合同.pdf',
        storedName: 'acc/msg/files/合同.pdf',
        bytes: 1,
        mime: '',
        openedAt: 1_000,
      }),
    )
    const second = store().record(
      entry({
        hash,
        name: '合同.pdf',
        storedName: 'acc/msg/files/合同 (a1b2c3d4).pdf',
        bytes: 1,
        mime: '',
        openedAt: 2_000,
      }),
    )

    expect(second.id).toBe(first.id)
    expect(second.storedName).toBe('acc/msg/files/合同 (a1b2c3d4).pdf')
    expect(store().byHash(hash)).toHaveLength(1)
  })

  it('中文子串搜索命中（trigram）', () => {
    store().record(
      entry({
        hash: 'd'.repeat(64),
        name: '2026年第三季度采购合同.pdf',
        bytes: 1,
        mime: '',
        openedAt: 3_000,
      }),
    )

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
    store().record(
      entry({ hash, name: '待删除-独特词-zzz.pdf', bytes: 1, mime: '', openedAt: 4_000 }),
    )

    const removed = store().deleteByHashes([hash])

    expect(removed).toBe(1)
    // 索引没同步的症状是"搜得到但记录已不存在"——悬空记录比漏搜更难查。
    expect(store().list({ text: '独特词' })).toHaveLength(0)
  })

  it('删除不存在的哈希返回 0 而不是抛错', () => {
    expect(store().deleteByHashes(['f'.repeat(64)])).toBe(0)
    expect(store().deleteByHashes([])).toBe(0)
  })

  it('旧库：补上 stored_name 列，旧记录读回来回落到哈希名', async () => {
    // 手搓一个 ADR-0031 之前的库：没有 stored_name 列，正文就是内容哈希。
    const { default: Database } = await import('better-sqlite3')
    const path = join(root, 'legacy.sqlite')
    const hash = '9'.repeat(64)

    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT NOT NULL,
        name TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        mime TEXT NOT NULL DEFAULT '',
        opened_at INTEGER NOT NULL,
        chat_label TEXT
      );
      INSERT INTO files (hash, name, bytes, mime, opened_at)
      VALUES ('${hash}', '旧文件.pdf', 1, '', 1);
    `)
    legacy.close()

    const module = await import('../../src/main/archive/store')
    const upgraded = new module.ArchiveStore(path)

    try {
      // 列被补上了（否则 record() 会抛 "no such column"），而旧记录那一列为空 ——
      // 读取时回落到哈希名，正是旧布局里正文的实际名字。
      expect(upgraded.byId(1)?.storedName).toBe(hash)
      expect(upgraded.byId(1)?.name).toBe('旧文件.pdf')

      // 补列之后还能正常写入新记录。
      const written = upgraded.record({
        hash: '8'.repeat(64),
        name: '新文件.pdf',
        storedName: '新文件.pdf',
        bytes: 2,
        mime: '',
        openedAt: 2,
      })

      expect(upgraded.byId(written.id)?.storedName).toBe('新文件.pdf')
    } finally {
      upgraded.close()
    }
  })
})

describe.skipIf(available)('ArchiveStore（跳过）', () => {
  it(probe.reason, () => {
    // 这条用例存在的唯一目的是让"为什么跳过了"出现在测试输出里，
    // 而不是留下一个没有解释的 skip 标记：原因里包含崩在哪一段与什么信号。
    expect(available).toBe(false)
  })
})

/**
 * 归档容量上限的淘汰（[ADR-0048]）。
 *
 * 与上一组分开：这里需要**真实存在于磁盘上**的正文（`usage()` 数的是文件，不是索引记录），
 * 而且每条用例都从空的索引与空的归档目录开始 —— 淘汰会删记录，共用一份数据会让用例之间
 * 互相影响，"哪条先跑"就变成了断言的一部分。
 */
describe.skipIf(!available)('ArchiveStore.enforceLimit', () => {
  /** 每条用例自己的归档目录：`usage()` 读的是这个全局值。 */
  const DIR = 'unknown-account/files/2026-10'

  let root: string
  let media: string
  let instance: ArchiveStore | null = null
  let sequence = 0

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'waachat-limit-'))
    media = join(root, 'media')
  })

  beforeEach(async () => {
    rmSync(media, { recursive: true, force: true })
    setArchiveDir(media)
    ensureArchiveDir()

    // 每条用例一个新库：淘汰会删记录，复用同一个库等于把上一条用例的状态写进断言。
    sequence += 1
    const module = await import('../../src/main/archive/store')
    instance = new module.ArchiveStore(join(root, `index-${String(sequence)}.sqlite`))
  })

  afterEach(() => {
    instance?.close()
    instance = null
  })

  afterAll(() => {
    setArchiveDir('')
    rmSync(root, { recursive: true, force: true })
  })

  /** 已初始化的 store（访问器而不是非空断言：失败时给出原因，而不是一串 TypeError）。 */
  function store(): ArchiveStore {
    if (instance === null) throw new Error('ArchiveStore 未初始化（beforeEach 未成功执行）')
    return instance
  }

  /** 造一份**真实存在于磁盘上**的正文，并把它记进索引（`bytes` 必须与磁盘一致）。 */
  function archived(hash: string, name: string, content: string, openedAt: number): string {
    const storedName = `${DIR}/${name}`
    const path = archiveFilePath(storedName)

    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    store().record({ hash, name, storedName, bytes: content.length, mime: '', openedAt })

    return storedName
  }

  it('删掉最久未访问的那份：文件与索引记录一起消失（不留悬空记录）', () => {
    const oldest = archived('1'.repeat(64), '最早.pdf', 'x'.repeat(10), 1_000)
    const newest = archived('2'.repeat(64), '较新.pdf', 'y'.repeat(10), 2_000)

    // 两个 10 字节的文件，上限放在"只够留一份"的位置上。
    const removed = store().enforceLimit(usage().bytes - 10)

    expect(removed).toBe(1)
    expect(existsSync(archiveFilePath(oldest))).toBe(false)
    expect(existsSync(archiveFilePath(newest))).toBe(true)

    // 关键：索引必须同步清掉 —— 只删文件会留下"搜得到但打不开"的悬空记录。
    expect(store().list({ text: '最早' })).toHaveLength(0)
    expect(store().list({ text: '较新' })).toHaveLength(1)
  })

  it('一份内容的所有记录一起删（同一个 hash = 同一份内容）', () => {
    const hash = '3'.repeat(64)
    const primary = archived(hash, '甲.pdf', 'z'.repeat(10), 1_000)

    // 第二个名字：硬链接到同一个 inode，因此占用不变，但索引里是**另一条记录**。
    const alias = `${DIR}/乙.pdf`
    linkSync(archiveFilePath(primary), archiveFilePath(alias))
    store().record({
      hash,
      name: '乙.pdf',
      storedName: alias,
      bytes: 10,
      mime: '',
      openedAt: 2_000,
    })

    expect(store().byHash(hash)).toHaveLength(2)

    const removed = store().enforceLimit(1)

    // 两条记录一起消失：只删一条会留下一个指向"其实已经不存在的内容"的名字。
    expect(removed).toBe(2)
    expect(store().byHash(hash)).toHaveLength(0)
    expect(existsSync(archiveFilePath(primary))).toBe(false)
    expect(existsSync(archiveFilePath(alias))).toBe(false)
  })

  it('上限为 0（不限制）或占用没超标时什么都不做', () => {
    const kept = archived('4'.repeat(64), '保留.pdf', 'k'.repeat(10), 1_000)

    expect(store().enforceLimit(0)).toBe(0)
    expect(store().enforceLimit(-1)).toBe(0)
    expect(store().enforceLimit(Number.NaN)).toBe(0)
    expect(store().enforceLimit(usage().bytes)).toBe(0)

    expect(existsSync(archiveFilePath(kept))).toBe(true)
    expect(store().list({ text: '保留' })).toHaveLength(1)
  })
})
