/**
 * 文件名净化。
 *
 * 为什么这是一个独立模块，而不是塞在 `integration/open.ts` 里：
 *
 *  1. **这是安全关键代码**，必须有单测（`ai/CONVENTIONS.md` 第 8 节：可单测的逻辑
 *     不得与 Electron API 混在一个文件里）。`open.ts` 顶层 `import { shell } from
 *     'electron'`，任何 import 它的测试都会拉起 Electron 运行时。
 *  2. 它只做一件事，且没有 IO —— 输入一个不可信字符串，输出一个安全文件名。
 *
 * 输入不可信这一点值得重复：文件名由**对端发送者**决定（`报告.pdf` 还是
 * `../../../../home/edwin/.bashrc`），直接当路径用就是路径穿越。
 */

/** 文件名长度上限。够长以保留信息，又不至于撞上路径长度限制（Linux PATH_MAX 4096）。 */
const MAX_NAME_LENGTH = 180

/** 内容未知、扩展名也未知时的兜底名。带上 `.bin` 是为了让 MIME 推断至少有结果。 */
export const FALLBACK_NAME = 'file.bin'

/**
 * 把任意字符串变成安全的、**单层**的文件名。
 *
 * 规则逐条都有对应的攻击或故障：
 *
 *   - 只取 `basename`      → 掐掉 `../../` 这类目录穿越
 *   - 去掉 `\` 与 NUL      → 防止在其它平台或经 shell 传递时被解释为路径
 *   - 去掉控制字符         → 它们会污染终端输出与日志
 *   - 不许以点开头         → 否则会与归档内部的 `.part-*` / `.index.sqlite*` 同名，或变成隐藏文件
 *   - 长度截断并保留扩展名 → 截断不能把 `.pdf` 砍掉，否则打开方式就丢了
 *
 * 注意：这里**不做** Unicode 归一化。`NFC` / `NFD` 两种形式的中文或重音字符都能安全
 * 落盘，而引入归一化会让"用户看到的文件名"与我们保存的名字不一致 —— 那是更糟的失真。
 */
export function sanitizeFileName(raw: string): string {
  const base = basename(raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/^\.+/, '')
    .trim()

  if (base.length === 0) return FALLBACK_NAME

  if (base.length <= MAX_NAME_LENGTH) return base

  const dot = base.lastIndexOf('.')
  // `dot <= 0` 覆盖两种"没有可用扩展名"的情况：完全没有点，或以点开头（已被上面清掉）。
  if (dot <= 0) return base.slice(0, MAX_NAME_LENGTH)

  const extension = base.slice(dot)
  const stem = base.slice(0, dot)

  // `Math.max(1, …)` 保证删到极限时仍留下一个字符的主干 —— 结果是 `a.pdf` 而不是 `.pdf`。
  return `${stem.slice(0, Math.max(1, MAX_NAME_LENGTH - extension.length))}${extension}`
}

/**
 * 跨平台 basename。
 *
 * 刻意**不**用 `node:path` 的 `basename`：那个版本只按当前平台的
 * `path.sep` 切分，而 Windows 客户端发来的文件名可能带 `\`。这里对两种
 * 分隔符都切，切完的残余由 `sanitizeFileName` 里的 `[/\\] → _` 兜住。
 */
function basename(raw: string): string {
  const lastSlash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
  return lastSlash === -1 ? raw : raw.slice(lastSlash + 1)
}

/** 冲突候选里哈希前缀的长度，依次尝试；最后一个是完整哈希（理论上不可能再冲突）。 */
const SUFFIX_LENGTHS = [8, 16] as const

/**
 * 一份内容在归档目录里的**候选文件名**，按优先级排列（[ADR-0031]）。
 *
 *   报告.pdf  →  报告 (a1b2c3d4).pdf  →  报告 (a1b2c3d4e5f6a7b8).pdf  →  报告 (完整哈希).pdf
 *
 * 第一个候选永远是**净化后的原名**，因此正常情况（这个名字没被别的内容占着）落盘的就是
 * 用户认得出来的名字；只有真冲突时才多一小段哈希。
 *
 * 为什么用哈希后缀而不是浏览器式的 `报告 (1).pdf`：后者要扫描目录找空位，名字会随目录内容
 * 变化（删掉 `(1)` 之后下一个同名文件又变成 `(1)`），而索引里存着这个名字 —— 失配就是
 * "搜得到但打不开"。哈希后缀是**确定性**的：同一个哈希总能算出同一个名字。
 *
 * 纯函数（不碰文件系统），因此"哪个候选能被用上"由调用方按 `existsSync` 决定。
 */
export function archiveNameCandidates(rawName: string, hash: string): string[] {
  const plain = sanitizeFileName(rawName)
  const suffixes = [...SUFFIX_LENGTHS.map((length) => hash.slice(0, length)), hash]

  return [plain, ...suffixes.map((suffix) => withHashSuffix(plain, suffix))]
}

/**
 * 把哈希后缀插在**扩展名之前**：`报告.pdf` + `a1b2c3d4` → `报告 (a1b2c3d4).pdf`。
 *
 * 扩展名必须留在最后一段，否则系统按扩展名推断 MIME 就失效了 —— 那正是这次改动要修的问题
 * 之一。同时按 {@link MAX_NAME_LENGTH} 截断主干：加上后缀之后可能超出限制。
 */
function withHashSuffix(name: string, suffix: string): string {
  const dot = name.lastIndexOf('.')
  const extension = dot <= 0 ? '' : name.slice(dot)
  const stem = dot <= 0 ? name : name.slice(0, dot)

  const marker = ` (${suffix})`
  const room = Math.max(1, MAX_NAME_LENGTH - extension.length - marker.length)

  return `${stem.slice(0, room)}${marker}${extension}`
}
