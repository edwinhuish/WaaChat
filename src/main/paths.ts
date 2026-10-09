/**
 * 本地目录布局。
 *
 * 这个文件是 [ADR-0008] 在代码里的落点：登录态、归档、密文缓存**必须**分开存放，
 * 因为三者的删除后果完全不同。
 *
 *   登录态（会话分区）删了要重新扫码   → 任何"清理"功能都不许碰
 *   归档              用户资产，可能不可恢复 → 只在用户明确要求时删
 *   cache/            纯派生数据，删了不影响   → 随时可删
 *
 * 把它们放在同一个目录下靠命名区分是可以工作的，但物理隔离依赖文件系统而不是
 * 依赖代码正确性 —— 后者在多年维护后并不可靠。
 *
 * 归档位置是**用户可配置**的（[ADR-0018]），因此它由 {@link setArchiveDir} 注入，
 * 不能从 XDG 变量推导。其余三者仍在 XDG 目录下：它们是应用的内部状态，
 * 用户没有"我想把登录态放在哪"这个需求。
 *
 * ⚠️ 本模块**不导入 electron**（`main/index.ts` 负责在启动时把设置喂进来），
 * 因此 `scripts/check-capture.ts` 与单测可以在没有 Electron 的环境里直接断言它。
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** 应用标识在文件系统层面的名字，与 package.json 的 name 一致。 */
const APP_DIR_NAME = 'waachat'

/** 默认归档目录名。放在用户的文档目录下 —— 文件是用户的东西，应该出现在他能自己找到的地方。 */
const ARCHIVE_DIR_NAME = 'WaaChat_files'

/**
 * 归档索引的文件名。
 *
 * 以点开头，因此 `blobs.usage()` 与 `sweepTempFiles()` 都会跳过它 ——
 * 它不会被当成一份归档文件统计或清理。
 */
const ARCHIVE_INDEX_FILE = '.index.sqlite'

/** XDG_DATA_HOME 规范默认值。 */
function dataHome(): string {
  return process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
}

/** XDG_CACHE_HOME 规范默认值。 */
function cacheHome(): string {
  return process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache')
}

/**
 * 归档的默认位置：`~/Downloads/WaaChat_files`。
 *
 * 选 `~/Downloads` 是因为它正是"官方网页版会把文件放进去"的那个目录 —— 用户对
 * "我下载的东西在哪"的直觉就建立在这上面，而本应用的卖点恰恰是"不再需要走一遍下载"。
 * 目录本身由 `archive/blobs.ts` 的 `ensureArchiveDir()` 在启动时创建（`mkdir` 的
 * `recursive` 会连 `~/Downloads` 一起补上），不需要用户先手工建。
 */
export const defaultArchiveDir = (): string => join(homedir(), 'Downloads', ARCHIVE_DIR_NAME)

/**
 * 把用户给的路径规整成一个可用的归档根目录；不可用时返回 `null`（调用方回落到默认位置）。
 *
 * 拒绝的每一种情形都是**会造成灾难**的那一类，而不是洁癖：
 *
 *   - 空 / 非绝对路径：没有可靠的解析基准，结果取决于进程的工作目录。
 *   - 只有一段的路径（`/`、`/home`、`/opt`）：`退出时清除归档` 会把它清空。
 *   - 家目录本身：同上，后果是用户自己的文件全没了。
 *
 * 这是**纯函数**，因此 `scripts/check-capture.ts` 与单测可以直接覆盖它 ——
 * 而这个校验恰恰是"用户手改了 settings.json 之后"唯一的防线。
 */
export function normalizeArchiveDir(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null

  const trimmed = raw.trim()
  if (trimmed === '' || !isAbsolute(trimmed)) return null

  // `/a/b/` 与 `/a/b` 是同一个目录。保留原样会让"是否等于默认位置"这类字符串比较失效。
  const normalized = trimmed.replace(/\/+$/, '')
  if (normalized === '') return null

  const segments = normalized.split('/').filter((part) => part !== '')
  if (segments.length < 2) return null
  if (normalized === homedir()) return null

  return normalized
}

/**
 * 当前生效的归档根目录。
 *
 * 权限必须是 0700（见 docs/security.md 第 2 节），因为里面的文件是**解密后的明文**。
 * 它现在可能落在用户的文档目录下 —— 那里的目录往往是用户自己建的 0755，
 * 因此 `blobs.ensureArchiveDir()` 会把权限收紧，而不是只依赖 `mkdir` 的 mode。
 */
let configured: string | null = null

/** 当前生效的归档根目录；未设置或设置不可用时是默认位置。 */
export const archiveDir = (): string => configured ?? defaultArchiveDir()

/**
 * 设置归档根目录（`null` / 空 / 不合法 = 回到默认位置），返回最终生效的绝对路径。
 *
 * 只改这个模块里的一个变量 —— 建目录、收紧权限、把索引连接挪过去，
 * 是 `archive/store.ts` 的 `applyArchiveDir()` 的职责。
 */
export function setArchiveDir(raw: string | null | undefined): string {
  configured = normalizeArchiveDir(raw)
  return archiveDir()
}

/**
 * 归档索引数据库。
 *
 * 放在归档目录**内部**：它描述的就是这个目录里的内容，"跟着归档一起备份或一起删除
 * 才是对的"。这也让"更换保存位置"变成一次完整的切换 —— 文件与索引一起换，
 * 不会出现"索引里有记录、新目录里没有文件"的悬空状态（[ADR-0018]）。
 *
 * 注意它包含元数据（谁在何时打开过什么文件），因此所在目录的权限同样要收紧。
 */
export const indexDbPath = (): string => join(archiveDir(), ARCHIVE_INDEX_FILE)

/**
 * 密文缓存目录。
 *
 * 存的是**未解密**的字节流，因此即使泄露，危害低于归档目录。可随时删除。
 * 它不随归档位置移动：它是派生数据，放在 XDG 缓存/数据目录下才是对的。
 */
export const ciphertextCacheDir = (): string => join(dataHome(), APP_DIR_NAME, 'cache')

/** 日志目录。放在 XDG_CACHE_HOME 下 —— 日志是派生物，用户清缓存时清掉它是对的。 */
export const logDir = (): string => join(cacheHome(), APP_DIR_NAME, 'logs')
