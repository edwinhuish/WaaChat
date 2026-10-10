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

import { ACCOUNT_FALLBACK, FILES_SEGMENT } from './archive/layout'

/** 应用标识在文件系统层面的名字，与 package.json 的 name 一致。 */
const APP_DIR_NAME = 'waachat'

/**
 * 默认归档目录名。
 *
 * 用的是**项目名**，不是服务方的名字：这个目录是**我们创建在用户磁盘上的产物**，而它是用户
 * 唯一会在自己的文件管理器里天天看见的那一处 —— 写服务方名称容易被读成"官方目录/官方客户端
 * 生成的"。代码里出现 `web.whatsapp.com` 那类**指示性使用**不受影响，[INV-4] 也不覆盖数据
 * 目录命名；这里只是在可选的地方选更保守的一边。理由与取舍见 [ADR-0032]（它取代了
 * [ADR-0023] 关于名称的那一半）。
 */
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
 * 归档的默认位置：`~/Documents/WaaChat_files`。
 *
 * 放在文档目录下，因为归档是**用户自己的文件**：他应该能自己念出这个路径、自己找到它、
 * 自己决定备份还是删掉（[ADR-0018] 的原始理由）。
 *
 * ⚠️ `~/Documents` 在很多桌面环境里是同步盘的地盘。这条风险由文档承担
 * （`docs/usage.md` 第 4 节明确写了不要把归档放进同步盘），而不是换一个"更安全"、
 * 但用户想不到也找不到的位置 —— 取舍见 [ADR-0023]（位置）与 [ADR-0032]（名称）。
 *
 * 目录本身由 `archive/blobs.ts` 的 `ensureArchiveDir()` 在启动时创建（`mkdir` 的
 * `recursive` 会连 `~/Documents` 一起补上），不需要用户先手工建。
 */
export const defaultArchiveDir = (): string => join(homedir(), 'Documents', ARCHIVE_DIR_NAME)

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
 * 账号标识（[ADR-0039]）：归档与密文两棵树都按它分一层目录。
 *
 * 值来自分区会话里那条 `wa_ul` cookie（`wa_ul` 是页面自己第一次加载时写下的随机 UUID），
 * 由 `src/main/account.ts` 在启动时读一次并调 {@link setAccountKey} 灌进来 —— 这个模块
 * **不导入 electron**（与 `setArchiveDir` 同一条纪律：单测与离线自检要能直接用它）。
 *
 * 拿不到时用 {@link ACCOUNT_FALLBACK}：那是个正常状态（还没登录 / cookie 被清过），
 * 而不是错误 —— 文件照常归档，只是落在一个叫 `unknown-account` 的目录里。
 */
let configuredAccount: string | null = null

/**
 * 账号名的最大长度。真的 UUID 是 36 字符；留一倍余量给将来的标识形状。
 */
const ACCOUNT_MAX_LENGTH = 72

/** 目录名的合法字符：小写字母、数字、点、下划线、连字符。 */
const ACCOUNT_UNSAFE = /[^a-z0-9._-]/g

/**
 * 把 cookie 里的值整成一个**单段目录名**；不可用时返回 `null`（调用方回落到
 * {@link ACCOUNT_FALLBACK}）。
 *
 * 这是**安全关键**的净化，理由与 `archive/naming.ts` 相同：这个值来自页面的存储，
 * 我们把它当目录名用，因此 `/`、`..`、控制字符都必须挡掉。规则：
 *
 *   - 只保留 `[a-z0-9._-]`（大写折成小写），其余一律删掉；
 *   - 空、`.`、`..`、以点开头都不接受（点开头会与归档内部的 `.part-*` / `.index.sqlite*` 混在一起）；
 *   - 超长截断（真实标识远不到 72 字符）。
 *
 * 纯函数，因此单测与离线自检都能直接断言它。
 */
export function normalizeAccountKey(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null

  const cleaned = raw.trim().toLowerCase().replace(ACCOUNT_UNSAFE, '')
  if (cleaned === '' || cleaned === '.' || cleaned === '..' || cleaned.startsWith('.')) return null

  return cleaned.slice(0, ACCOUNT_MAX_LENGTH)
}

/**
 * 设置账号标识（不合法 / 空 = 回落到 {@link ACCOUNT_FALLBACK}），返回最终生效的值。
 *
 * 只改这个模块里的一个变量 —— 建目录、收权限是 `archive/blobs.ts` 与
 * `capture/cache-files.ts` 的职责（与 `setArchiveDir()` 同一条分工）。
 */
export function setAccountKey(raw: string | null | undefined): string {
  configuredAccount = normalizeAccountKey(raw)
  return accountKey()
}

/** 当前生效的账号标识；没设或设不进去时是 {@link ACCOUNT_FALLBACK}。 */
export const accountKey = (): string => configuredAccount ?? ACCOUNT_FALLBACK

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
 *
 * ⚠️ 它是**一整个归档一棵**（不在账号目录里，[ADR-0039]）：账号只是磁盘上的分层，
 * 而"我打开过的文件"是一个整体，搜索不该先在界面上选账号。
 */
export const indexDbPath = (): string => join(archiveDir(), ARCHIVE_INDEX_FILE)

/**
 * 归档里属于某个账号的那一层：`<归档根>/<账号>`。
 *
 * 账号名由 `accountKey()` 给（cookie 里的标识；拿不到就是 `unknown-account`）。
 */
export const archiveAccountDir = (): string => join(archiveDir(), accountKey())

/** 明文正文的容器：`<归档根>/<账号>/files`（[ADR-0039]）。 */
export const archiveFilesDir = (): string => join(archiveAccountDir(), FILES_SEGMENT)

/**
 * 密文缓存目录（**根**）。
 *
 * 存的是**未解密**的字节流，因此即使泄露，危害低于归档目录。可随时删除。
 * 它不随归档位置移动：它是派生数据，放在 XDG 缓存/数据目录下才是对的。
 *
 * 账号与月份各占一层：`<这里>/<账号>/<年-月>/<key>.bin`（[ADR-0039]）。分层的理由与归档
 * 相同（看得清、删得干净），但**根目录仍然独立** —— 这是 [ADR-0008] 的物理隔离：
 * "清除归档"与"关闭密文缓存"因此都不可能误伤对方。
 */
export const ciphertextCacheDir = (): string => join(dataHome(), APP_DIR_NAME, 'cache')

/** 密文缓存里属于某个账号的那一层：`<缓存根>/<账号>`。 */
export const ciphertextAccountDir = (): string => join(ciphertextCacheDir(), accountKey())

/** 日志目录。放在 XDG_CACHE_HOME 下 —— 日志是派生物，用户清缓存时清掉它是对的。 */
export const logDir = (): string => join(cacheHome(), APP_DIR_NAME, 'logs')
