/**
 * 早期文件身份探针（`test/fixtures/probe-media-metadata.js`）的单测。
 *
 * 为什么这件事值得测：那段探针是**贴进别人的页面、并会出现在控制台里**的诊断工具，
 * 它有两个不能靠人记住的性质：
 *
 *   1. **绝不把 `mediaKey` / `url` 之类的值打印出来** —— 只报长度。一旦破掉，密钥就
 *      落进了控制台日志（而它本来是要被贴出来给人看的）。
 *   2. **必须走原型链上的 getter** —— WA Web 的模型大量使用 `get` 访问器；只看 own keys
 *      的实现会漏字段，而漏掉的那个字段可能正是这个探针唯一的结论来源
 *      （见 `docs/research/early-file-identity.md` §3）。
 *
 * 这两个性质都不是"写的时候小心一点"能保证的，所以用假模型把它真跑一遍。
 *
 * 探针是**粘贴型脚本**：有任何一个 `import` 它就没法粘进控制台，因此只能在受控的
 * `window` / `console` 上求值 —— 这也是 `test/fixtures/` 下那个文件唯一的消费方式。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const PROBE_SOURCE = readFileSync(
  new URL('../fixtures/probe-media-metadata.js', import.meta.url),
  'utf8',
)

/**
 * 故意把标记串**真的放进对象里**。
 *
 * ⚠️ 第一版的夹具只声明了这个常量、却从未把它赋给 `mediaKey`（那里放的是 32 个 7），
 * 于是"没有打印 mediaKey 的值"这条断言**恒为真**——一条永远绿的假防线。真正的断言必须
 * 让"值被打印"成为**可见**的后果。
 */
const SECRET_MEDIA_KEY = 'MEDIAKEY-VALUE-MUST-NOT-APPEAR'
const SECRET_URL = 'SECRETSIG-MUST-NOT-APPEAR'

interface FieldRow {
  字段: string
  出现: string
  类型: string
  消息类型: string
  明文哈希: string
  密钥派生: string
}

interface CompareRow {
  字段: string
  通道A: string
  通道B: string
  相同: string
}

interface Captured {
  扩展名: string | null
  扩展名来源: string | null
  指纹: Record<string, string>
}

interface ProbeState {
  captured: Record<string, Captured>
  runs: unknown[]
  capture: (channel: string) => unknown
  compare: () => void
  /**
   * 报告是**唯一会被整段贴出来给人看**的东西（`__waProbe.report()`），因此它的断言与
   * 控制台输出同等重要：少一句限定条件，看报告的人就会得出错误结论。
   */
  report: () => string
}

interface ProbeWindow {
  require: (name: string) => unknown
  __waProbe?: ProbeState
}

/** 造一个 32 字节的可辨识摘要：同一个 seed 必然得到同一份字节。 */
const digest = (seed: number) => Uint8Array.from({ length: 32 }, (_, index) => (index + seed) % 256)

/** 假的媒体模型：刻意把 `url` 做成**原型链上的 getter** —— 只看 own keys 的实现会漏掉它。 */
class FakeMediaData {
  mimetype = 'application/pdf'
  filesize = 12345
  directPath = '/v/t62.7118-24/1234567890_n.enc'
  // 用字符串而不是 Uint8Array：只要有人把"值"打出来，标记串就会出现在输出里。
  mediaKey: unknown = SECRET_MEDIA_KEY
  fileSha256: Uint8Array
  fileEncSha256: Uint8Array
  filehash: string

  constructor({ shaSeed, filehash }: { shaSeed: number; filehash: string }) {
    /**
     * 两个哈希都随内容变化 —— 它们本来就是同一份内容的两种摘要。
     *
     * ⚠️ 第一版把 `fileEncSha256` 写成了常量，于是"不同内容"那个用例里它跨通道相同，
     * 探针**正确地**判定它是「内容身份」字段。错的是这个假模型，不是探针 —— 所以
     * 这条断言是真在起作用，而不是恰好通过。
     */
    this.fileSha256 = digest(shaSeed)
    this.fileEncSha256 = digest(shaSeed + 7)
    this.filehash = filehash
  }

  get url(): string {
    return `https://mmg.whatsapp.net/v/t62/x.enc?oh=${SECRET_URL}`
  }
}

const documentMessage = (filename: string, shaSeed: number, filehash = 'aaaa') => ({
  type: 'document',
  filename,
  mediaData: new FakeMediaData({ shaSeed, filehash }),
})

/**
 * 实测的第二个形状：**消息上没有 `filename`**，文件名挂在媒体对象上。
 *
 * 第一版的 `capture` 只读 `msg.filename`，于是两个通道都记下 `扩展名: null` ——
 * 而元信息行仍然断称"已覆盖 P3 的改名情形"。P3 从未被覆盖，却看起来覆盖了。
 */
const messageWithMediaFilename = (filename: string) => ({
  type: 'document',
  mediaData: {
    mimetype: 'application/pdf',
    filesize: 42,
    filename,
    fileSha256: digest(42),
  },
})

/** 既没有明文也没有密文 SHA-256 的媒体 —— 实测的第三种形状。 */
const messageWithoutHashes = () => ({
  type: 'image',
  mediaData: { mimetype: 'image/jpeg', filesize: 999 },
})

/**
 * 造一个受控的运行环境。
 *
 * `run()` 可以反复调用、且**状态留在同一个 window 上** —— 这正是真实用法：WA Web 是单页
 * 应用，切会话不刷新页面，所以 `window.__waProbe` 跨会话存活。
 */
function makeProbeTarget(initial: readonly unknown[]) {
  const logs: string[] = []
  const tables: unknown[][] = []
  let messages: readonly unknown[] = initial

  const spyConsole = {
    info: (...args: unknown[]) => logs.push(args.join(' ')),
    warn: (...args: unknown[]) => logs.push(args.join(' ')),
    log: (...args: unknown[]) => logs.push(args.join(' ')),
    table: (rows: unknown) => tables.push(rows as unknown[]),
    group: () => {},
    groupEnd: () => {},
  }

  const win: ProbeWindow = {
    require: (name: string) =>
      name === 'WAWebCollections' ? { Msg: { getModelsArray: () => messages } } : undefined,
  }

  return {
    win,
    clear: () => {
      logs.length = 0
      tables.length = 0
    },
    output: () => logs.join('\n'),
    fieldRows: () => (tables[0] ?? []) as FieldRow[],
    compareRows: () => (tables[0] ?? []) as CompareRow[],
    run: (next?: readonly unknown[]) => {
      if (next) messages = next
      logs.length = 0
      tables.length = 0
      // 只给它 window / console 两个入口 —— 粘贴型脚本本来就只有这些。
      //
      // 刻意**不用** `node:vm`：`runInNewContext` 会造出一个新 realm，探针里的
      // `instanceof Uint8Array` 就认不出本 realm 造的假模型了（会静默地一个字段都识别不到）。
      new Function('window', 'console', PROBE_SOURCE)(win, spyConsole)
      return logs.join('\n')
    },
  }
}

describe('探针：定位消息集合', () => {
  it('报告消息集合取自上哪条路径 —— 上游换位置时这是第一条线索', () => {
    const target = makeProbeTarget([documentMessage('报告.pdf', 42)])

    expect(target.run()).toContain('消息集合来自：window.require("WAWebCollections").Msg')
  })

  it('找不到集合时不抛错，而是把试过的路径都列出来', () => {
    const target = makeProbeTarget([documentMessage('报告.pdf', 42)])
    target.win.require = () => undefined

    const output = target.run()

    expect(output).toContain('没找到消息集合')
    expect(output).toContain('这本身就是一个结论')
    // 失败分支必须给出**可执行的下一步**，否则这一趟就白跑了。
    expect(output).toContain('webpackChunk')
  })

  it('没有带媒体的消息时给出可读提示，而不是静默通过', () => {
    const target = makeProbeTarget([{ type: 'chat' }])
    const output = target.run()

    expect(output).toContain('没有带媒体的消息')
    /**
     * "字段是懒加载的" 与 "这个会话确实没有媒体" 是两回事，但症状一样。
     * 它们对结论的影响完全不同：懒加载意味着**下载前拿不到标识**，方案 B 就废了一半。
     */
    expect(output).toContain('懒加载')
  })
})

describe('探针：P1 字段识别', () => {
  it('认出明文 SHA-256，并判定"走方案 B、不需要动 INV-3"', () => {
    const target = makeProbeTarget([documentMessage('报告.pdf', 42)])
    const output = target.run()

    expect(output).toContain('明文 SHA-256 字段（fileSha256 或等价物）：✓ 有')
    expect(output).toContain('走方案 B')
    expect(output).not.toContain('必须先就 INV-3 立一条 ADR')
  })

  it('把密钥派生的 filehash 标上 INV-3 警告', () => {
    const target = makeProbeTarget([documentMessage('报告.pdf', 42)])
    target.run()

    expect(target.fieldRows().find((row) => row.字段 === 'filehash')?.密钥派生).toBe('⚠ INV-3')
    expect(target.fieldRows().find((row) => row.字段 === 'fileSha256')?.明文哈希).toBe('★')
  })

  it('认得出原型链 getter 上的字段（只看 own keys 会漏掉 url）', () => {
    const target = makeProbeTarget([documentMessage('报告.pdf', 42)])
    target.run()

    const urlRow = target.fieldRows().find((row) => row.字段 === 'url')

    expect(urlRow).toBeDefined()
    expect(urlRow?.类型).toMatch(/^string\(len=\d+\)$/)
  })

  it('按消息类型汇总字段数（P4）', () => {
    const target = makeProbeTarget([documentMessage('报告.pdf', 42)])
    const output = target.run()

    expect(output).toContain('扫了 1 条消息，其中 1 条带媒体')
    expect(output).toContain('document')
  })
})

describe('探针：绝不泄漏值', () => {
  it('mediaKey 只报长度，值不出现', () => {
    const target = makeProbeTarget([documentMessage('报告.pdf', 42)])
    const output = target.run()

    expect(output).not.toContain(SECRET_MEDIA_KEY)
    // 正向证据：这条字段确实被扫到了，只是只报了长度 —— 否则"没打印"可能是因为压根没扫到。
    expect(target.fieldRows().find((row) => row.字段 === 'mediaKey')?.类型).toMatch(
      /^string\(len=\d+\)$/,
    )
  })

  it('url 只报长度，签名不出现', () => {
    const target = makeProbeTarget([documentMessage('报告.pdf', 42)])
    const output = target.run()

    expect(output).not.toContain(SECRET_URL)
    expect(target.fieldRows().find((row) => row.字段 === 'url')?.类型).toMatch(
      /^string\(len=\d+\)$/,
    )
  })
})

describe('探针：P2/P3 跨会话比较', () => {
  it('同一份内容在两个会话里 → 判定出「内容身份」字段', () => {
    const target = makeProbeTarget([documentMessage('报告.pdf', 42)])

    target.run()
    target.win.__waProbe?.capture('A')

    // 切到另一个会话：同一份内容（shaSeed 相同），但换了文件名、filehash 也变了。
    target.run([documentMessage('报告 (1).pdf', 42, 'bbbb')])
    target.win.__waProbe?.capture('B')

    target.clear()
    target.win.__waProbe?.compare()

    const shaRow = target.compareRows().find((row) => row.字段 === 'fileSha256')
    expect(shaRow?.相同).toBe('✓ 是')
    expect(target.output()).toContain('标识「内容」的字段')
  })

  it('不同内容 → 判定为「对象」标识，并明说不能当去重键', () => {
    const target = makeProbeTarget([documentMessage('报告.pdf', 42)])

    target.run()
    target.win.__waProbe?.capture('A')

    // 换了内容（shaSeed 不同）但名字相同 —— 指的是"另一份文件"。
    target.run([documentMessage('报告.pdf', 99)])
    target.win.__waProbe?.capture('B')

    target.clear()
    target.win.__waProbe?.compare()

    expect(target.compareRows().find((row) => row.字段 === 'fileSha256')?.相同).toBe('✗ 否')
    expect(target.output()).toContain('不能当去重键')
  })

  it('只 capture 了一个通道时给出提示，而不是静默返回', () => {
    const target = makeProbeTarget([documentMessage('报告.pdf', 42)])
    target.run()
    target.win.__waProbe?.capture('A')
    target.clear()

    target.win.__waProbe?.compare()

    expect(target.output()).toContain('至少 capture 两个通道')
  })

  it('忘了重跑探针就 capture 时会警告 —— 否则会静默地得出错误结论', () => {
    const target = makeProbeTarget([documentMessage('报告.pdf', 42)])

    target.run()
    target.win.__waProbe?.capture('A')

    target.clear()
    // 切了会话却没有重新扫描：这时 lastMedia 还指着上一条消息。
    target.win.__waProbe?.capture('B')

    expect(target.output()).toContain('没有重新扫描')
  })

  it('每个通道之间都重跑时不报警', () => {
    const target = makeProbeTarget([documentMessage('报告.pdf', 42)])

    target.run()
    target.win.__waProbe?.capture('A')

    target.clear()
    target.run()
    target.win.__waProbe?.capture('B')

    expect(target.output()).not.toContain('没有重新扫描')
  })

  it('capture 默认不碰密钥派生的 filehash（INV-3）', () => {
    const target = makeProbeTarget([documentMessage('报告.pdf', 42)])
    target.run()
    target.win.__waProbe?.capture('A')

    const captured = target.win.__waProbe?.captured.A

    expect(captured?.指纹.fileSha256).toBeTruthy()
    expect(captured?.扩展名).toBe('.pdf')
    expect(captured?.指纹.filehash).toBeUndefined()
  })

  it('文件名挂在媒体对象上时也能取到扩展名，并记录来源（实测消息上没有 filename）', () => {
    const target = makeProbeTarget([messageWithMediaFilename('报告.pdf')])
    target.run()
    target.win.__waProbe?.capture('A')

    const captured = target.win.__waProbe?.captured.A

    expect(captured?.扩展名).toBe('.pdf')
    expect(captured?.扩展名来源).toBe('media.value.filename')
  })

  it('两个通道扩展名相同（没改名）时明说 P3 未覆盖，而不是谎称覆盖了', () => {
    const target = makeProbeTarget([messageWithMediaFilename('报告.pdf')])

    target.run()
    target.win.__waProbe?.capture('A')
    target.run([messageWithMediaFilename('报告.pdf')])
    target.win.__waProbe?.capture('B')

    target.clear()
    target.win.__waProbe?.compare()

    expect(target.output()).toContain('P3 未覆盖')
    expect(target.output()).not.toContain('已覆盖 P3')
  })

  it('没有任何字段进入比较时说「根本没比」，而不是判定为「对象」标识', () => {
    const target = makeProbeTarget([messageWithoutHashes()])

    target.run()
    target.win.__waProbe?.capture('A')
    target.run([messageWithoutHashes()])
    target.win.__waProbe?.capture('B')

    target.clear()
    target.win.__waProbe?.compare()

    expect(target.output()).toContain('根本没比')
    // 缺陷 2 的原症状：从零次比较里得出"都只是对象标识"。
    expect(target.output()).not.toContain('不能当去重键')
  })
})

describe('探针：报告（整段贴出来给人看的那件东西）', () => {
  it('含全部结论：字段表、P1 判定、跨会话比较及其限定条件', () => {
    const target = makeProbeTarget([documentMessage('报告.pdf', 42)])

    target.run()
    target.win.__waProbe?.capture('A')

    // 同一份内容、扩展名不同 —— P3 的"改名/改扩展名"情形因此也算覆盖到了。
    target.run([documentMessage('截图.png', 42)])
    target.win.__waProbe?.capture('B')
    target.win.__waProbe?.compare()

    const report = target.win.__waProbe?.report() ?? ''

    /**
     * 表格必须是**文本**：`console.table` 的对象拷不出形状，而报告要能整段粘贴。
     * markdown 表是唯一同时满足"我能读"和"聊天窗口里不散架"的形态。
     */
    expect(report).toContain('| 字段 |')
    expect(report).toContain('| 明文哈希 |')
    expect(report).toContain('明文 SHA-256 字段（fileSha256 或等价物）：✓ 有')
    expect(report).toContain('P4 逐类型字段数')
    expect(report).toContain('### 通道 A')
    expect(report).toContain('扩展名：".pdf"（来源：msg.filename）')
    expect(report).toContain('标识「内容」的字段')
    expect(report).toContain('已覆盖 P3')
  })

  it('报告里绝不含被扫到的值 —— 这正是它可以整段贴出来的前提', () => {
    const target = makeProbeTarget([documentMessage('报告.pdf', 42)])

    target.run()
    target.win.__waProbe?.capture('A')

    const report = target.win.__waProbe?.report() ?? ''

    expect(report).not.toContain(SECRET_MEDIA_KEY)
    expect(report).not.toContain(SECRET_URL)
    // 正向证据：这两个字段确实进了报告，只是只报了类型与长度。
    expect(report).toContain('mediaKey（只报了长度')
    expect(report).toContain('| url |')
  })

  it('还没成功扫过时，报告给出下一步，而不是一张空表', () => {
    const target = makeProbeTarget([{ type: 'chat' }])
    target.run()

    const report = target.win.__waProbe?.report() ?? ''

    expect(report).toContain('还没成功扫描过')
    expect(report).toContain('__waProbe.scan()')
  })

  it('capture 走错流程（没重扫）时，那条警告必须进报告', () => {
    const target = makeProbeTarget([documentMessage('报告.pdf', 42)])

    target.run()
    target.win.__waProbe?.capture('A')
    // 切了会话却没重扫：两个通道记的是同一条消息，compare() 的结论不成立。
    target.win.__waProbe?.capture('B')

    expect(target.win.__waProbe?.report()).toContain('没有重新扫描')
  })
})
