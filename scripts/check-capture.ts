/**
 * 接管自检（离线）。
 *
 * 它回答的是一个问题：**"接管这一层还活着吗"**。
 *
 * 为什么需要它：本项目的失败模式里最糟的一种是"安静地退回上游的原生行为"——
 * 文件又被下载到 `~/Downloads`，应用什么也不说。而这个问题**只在真实点击时**暴露，
 * 也就是只有在用户已经装好、已经登录、已经等到那份文件之后。把这个判断提前到
 * 命令行，是这里存在的全部理由。
 *
 * 它**不**做的事：不联网、不启动 Electron、不需要登录。因此它跑得快、
 * 不会泄露任何东西，可以在任何一台机器上重复执行。
 *
 * 用法：
 *   npx tsx scripts/check-capture.ts
 *
 * 退出码非 0 表示有断言失败 —— 上游改版后这里通常最先变红。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ARCHIVE_FILE_MODE } from '../src/main/archive/blobs'
import {
  CHAT_FALLBACK,
  FILES_SEGMENT,
  archiveStoredPath,
  folderFor,
  isAccountSegment,
  isArchiveMonthDir,
  isChatSegment,
  normalizeChatId,
  normalizeStoredPath,
} from '../src/main/archive/layout'
import { isInsideArchive } from '../src/main/archive/export'
import { isAllowedTarget } from '../src/main/archive/migrate'
import { archiveNameCandidates, sanitizeFileName } from '../src/main/archive/naming'
import {
  BODY_SUFFIX,
  STAGING_DIR_NAME,
  cacheEntryDirs,
  isEntryName,
} from '../src/main/capture/cache-files'
import { deriveCacheKey, isMediaRequest } from '../src/main/capture/cachekey'
import { CARRIED_HEADERS, carriedHeaders } from '../src/main/capture/headers'
import {
  FETCH_METADATA_BY_RESOURCE_TYPE,
  applyRequestContext,
  clearRequestContexts,
  rememberRequestContext,
} from '../src/main/capture/request-context'
import {
  MAX_ATTEMPTS,
  describeNetworkError,
  isTransientNetworkError,
  nextDelayMs,
} from '../src/main/capture/retry'
import {
  APP_ICON_SIZE,
  CUSTOM_ICON_FILENAME,
  DESKTOP_ENTRY_COMMENT,
  DESKTOP_ENTRY_MARKER,
  buildDesktopEntry,
  coverCropRect,
  desktopEntryExec,
  isAcceptedIconName,
} from '../src/shared/appicon'
import { ACTION_BUTTON_CLASS } from '../src/shared/action-button'
import { APP_ID, DESKTOP_FILE_NAME } from '../src/shared/constants'
import {
  ARCHIVE_DIR_BASE_NAME,
  DEFAULT_INSTANCE_ID,
  INSTANCE_ARG,
  LEGACY_INSTANCE_ARG,
  instancePartition,
  parseInstanceArg,
  withInstanceSuffix,
} from '../src/shared/instance'
import {
  DEFAULT_SPELLCHECK_LANGUAGES,
  SPELLCHECK_LANGUAGES,
  adoptInterfaceDictionary,
  matchDictionaryLanguage,
  normalizeSpellcheckLanguages,
  parseDictionaryList,
  pickSpellcheckLanguage,
  resolveSpellcheckLanguages,
} from '../src/shared/language'
import {
  EXTRA_SETTINGS_ROWS,
  SETTINGS_ROW_ORDER,
  SETTINGS_SECTIONS,
  sectionOfRow,
} from '../src/shared/settings-sections'
import { SIZE_LIMIT_ENFORCED, describeSizeLimit } from '../src/shared/size-limit'
import {
  applyLinuxGpuSwitches,
  type CommandLineLike,
  usesWaylandOzone,
} from '../src/main/linux-gpu'
import { ALLOWED_PERMISSIONS, isPermissionAllowed } from '../src/main/permissions'
import { captureFailureBody, trackCaptureFailure } from '../src/shared/notice'
import { DEFAULT_SETTINGS, RESTART_REQUIRED_SETTINGS } from '../src/shared/types'
import {
  DEFAULT_THEME,
  THEME_OPTIONS,
  WINDOW_BACKGROUND,
  normalizeTheme,
} from '../src/shared/theme'
import {
  DEFAULT_ZOOM_FACTOR,
  MAX_ZOOM_FACTOR,
  MIN_ZOOM_FACTOR,
  ZOOM_OPTIONS,
  ZOOM_STEPS,
  normalizeZoomFactor,
  zoomStepDown,
  zoomStepUp,
} from '../src/shared/zoom'
import { UNREAD_BADGE_LIMIT, parseUnreadCount, unreadBadgeLabel } from '../src/shared/unread'
import { drawUnreadBadge } from '../src/shared/tray-badge'
import { NO_SMOOTH_SCROLLING_SWITCH, applySmoothScrolling } from '../src/main/smooth-scroll'
import { FULLSCREEN_HINT_BODY, trackFullscreenHint } from '../src/shared/notice'
import { CHAT_PROTOCOL, parseChatTarget } from '../src/shared/deep-link'
import { denialKey, trackDenial } from '../src/shared/permission-log'
import {
  accountKey,
  archiveDir,
  ciphertextCacheDir,
  defaultArchiveDir,
  indexDbPath,
  normalizeAccountKey,
  normalizeArchiveDir,
} from '../src/main/paths'
import { buildUserAgent, isCleanUserAgent } from '../src/shared/user-agent'

let failures = 0

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  \u001b[32m✓\u001b[0m ${label}`)
    return
  }
  failures += 1
  console.log(`  \u001b[31m✗\u001b[0m ${label}${detail === '' ? '' : ` —— ${detail}`}`)
}

function note(label: string): void {
  console.log(`  · ${label}`)
}

function section(title: string): void {
  console.log(`\n\u001b[1m${title}\u001b[0m`)
}

// ---------------------------------------------------------------------------
// 1. 缓存键推导
// ---------------------------------------------------------------------------
//
// 这一层坏掉的症状是"文件能打开但每次都要重新下载"，用户不会当成 bug 报出来。
// 因此把几条关键约定固化成断言：改 `VOLATILE_QUERY_PARAMS` 或匹配规则时，
// 这里应该立刻变红。

section('缓存键推导')

const MEDIA_URL = 'https://mmg.whatsapp.net/v/t62.7118-24/abc?oh=111&oe=222&ccb=10-15'
const MEDIA_URL_RESIGNED = 'https://mmg.whatsapp.net/v/t62.7118-24/abc?oh=999&oe=888&ccb=99'

check('媒体 CDN 被识别', isMediaRequest(MEDIA_URL))
check('区域 CDN 被识别', isMediaRequest('https://media-hkg4-1.cdn.whatsapp.net/v/t62.7118-24/abc'))
check('网页域不被识别', !isMediaRequest('https://web.whatsapp.com/'))
check('近似域不被识别', !isMediaRequest('https://evilwhatsapp.net/x'))

// 同一个 `whatsapp.net` 域里托管着网页自身要用的资源。它们落进密文缓存会绕过
// Chromium 自己的 HTTP 缓存重校验，上游发版后页面可能长期加载到旧模块 ——
// 判据收窄的依据与实测数据见 ADR-0015。
check('静态资源域不被识别', !isMediaRequest('https://static.whatsapp.net/rsrc.php/v4/y3/r/x.js'))
check('文档预览页不被识别', !isMediaRequest('https://webtp.whatsapp.net/pdf-viewer/?locale=zh_CN'))
check('流程页不被识别', !isMediaRequest('https://flows.whatsapp.net/flows/cache_management/'))

const key = deriveCacheKey(MEDIA_URL)
check('非媒体请求返回 null', deriveCacheKey('https://web.whatsapp.com/') === null)
check(
  '签名变化不改变缓存键',
  key !== null && key === deriveCacheKey(MEDIA_URL_RESIGNED),
  `得到 ${String(deriveCacheKey(MEDIA_URL_RESIGNED))}`,
)
note(`示例键：${String(key)}`)

// ---------------------------------------------------------------------------
// 2. UA
// ---------------------------------------------------------------------------
//
// UA 里混进 `Electron/` 的症状是"页面能打开但功能缺失"，同样很难归因。
// 这里用的是编译期的 Chromium 版本占位 —— 运行时以 process.versions.chrome 为准，
// 但"模板本身是否干净"在离线状态下就能验证。

section('User-Agent')

const ua = buildUserAgent('150.0.7871.129')
check('模板不含嵌入式运行时标记', isCleanUserAgent(ua))
note(`示例 UA：${ua}`)

// ---------------------------------------------------------------------------
// 3. 文件名净化
// ---------------------------------------------------------------------------

section('文件名净化（安全关键）')

check('路径穿越被剥掉', sanitizeFileName('../../etc/passwd') === 'passwd')
check('去掉前导点（不与归档内部条目同名）', sanitizeFileName('.part-x') === 'part-x')

// ---------------------------------------------------------------------------
// 4. 本地目录
// ---------------------------------------------------------------------------
//
// 归档目录的权限是 0700 的硬要求：里面是**解密后的明文**（docs/security.md 第 2 节）。

section('本地目录')

/**
 * 归档位置是**用户可配**的（ADR-0018），因此这里锁两件事：
 * 默认值落在文档目录下；危险路径挡得住 —— 后者是用户手改 `settings.json` 之后
 * `normalizeArchiveDir()` 之外的唯一防线。
 */
const home = homedir()

check(
  '默认归档位置在文档目录下',
  defaultArchiveDir() === join(home, 'Documents', 'WaaChat_files'),
  defaultArchiveDir(),
)
check('拒绝根目录', normalizeArchiveDir('/') === null)
check(
  '拒绝过于顶层的目录（清除归档会误伤）',
  normalizeArchiveDir('/home') === null && normalizeArchiveDir('/opt') === null,
)
check('拒绝家目录本身', normalizeArchiveDir(home) === null)
check('拒绝相对路径', normalizeArchiveDir('relative/dir') === null)
check('拒绝空值', normalizeArchiveDir('') === null && normalizeArchiveDir(null) === null)
check(
  '接受正常绝对路径并去掉尾部斜杠',
  normalizeArchiveDir(`${home}/Documents/x/`) === `${home}/Documents/x`,
  String(normalizeArchiveDir(`${home}/Documents/x/`)),
)
check('索引与归档同目录（换位置时一起换）', dirname(indexDbPath()) === archiveDir(), indexDbPath())

// 归档正文的权限是"只读"的硬要求：归档是内容寻址的，就地改一个字节就会让索引里的哈希与
// 内容不再相符（症状是"搜到但打开后不是当初那份"）。见 ADR-0031。
check('归档正文的权限是只读（0400）', ARCHIVE_FILE_MODE === 0o400)

// 归档正文的文件名判据：第一个候选必须是**净化后的原名**（不是哈希），冲突候选把哈希插在
// 扩展名之前。放宽或收紧都会静默改变"用户在文件夹里看到什么"，属于改了没人会立刻发现的那类。
const sampleHash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2'
check(
  '归档文件名优先用原文名',
  archiveNameCandidates('报告 2026Q3.pdf', sampleHash)[0] === '报告 2026Q3.pdf',
)
check(
  '同名冲突时改用带哈希后缀的候选名',
  archiveNameCandidates('报告.pdf', sampleHash)[1] === '报告 (a1b2c3d4).pdf',
)
check(
  '每个候选名都保留扩展名（否则系统推断不出 MIME）',
  archiveNameCandidates('合同.pdf', sampleHash).every((name) => name.endsWith('.pdf')),
)

// 归档的分层（ADR-0039 / ADR-0052 / ADR-0055）：正文在 `<账号>/<会话ID>/files/` 里，"账号"
// 来自页面写下的 `wa_ul`（一个 UUID），"会话ID"是页面上的会话 JID。这几条都属于"改了没人会
// 立刻发现"的那一类 —— 会话ID 净化漏掉会让页面给的值变成路径穿越点，容器判据放宽则会让迁移
// 把用户自己的目录当成正文搬走（收紧则会让自己的归档、以及 [ADR-0052] 时期的消息ID 目录迁移
// 不了）。月份相关的断言保留着：密文缓存仍按 `<账号>/<年-月>/` 分层，而旧布局必须继续被迁移
// 认出来。
const sampleAccount = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
check(
  '密文缓存的月份目录仍按本地时间算（单层、年-月）',
  folderFor(new Date(2026, 9, 5, 12).getTime()) === '2026-10',
  folderFor(new Date(2026, 9, 5, 12).getTime()),
)
check(
  '旧布局的月份判据仍收得够紧（`2026-13` / `2026-1` / 旧两层都不算；迁移要靠它认旧数据）',
  isArchiveMonthDir('2026-01') &&
    isArchiveMonthDir('2026-12') &&
    !isArchiveMonthDir('2026-13') &&
    !isArchiveMonthDir('2026-1') &&
    !isArchiveMonthDir('2026/10') &&
    !isArchiveMonthDir('2026'),
)
// 账号目录的判据是**迁移的安全边界**：只认 UUID 形状、unknown-account 与当前生效的那个名字，
// 否则用户自己放进归档目录的 `stuff/` 会被当成我们的容器搬走。
check(
  '账号目录只认自己的形状（`stuff` 不算）',
  isAccountSegment(sampleAccount, sampleAccount) &&
    isAccountSegment('unknown-account', sampleAccount) &&
    !isAccountSegment('stuff', sampleAccount) &&
    !isAccountSegment('2026-10', sampleAccount),
)
const sampleChat = '18665597400@c.us'
/** [ADR-0052] 时期的第二级：消息ID。它必须继续被认成我们的容器（老归档要能迁移）。 */
const sampleLegacyMessage = '3EB0A1B2C3D4E5F6A7B8'
check(
  '`stored_name` 的形态：账号 / 会话ID / files / 文件名',
  archiveStoredPath(sampleAccount, sampleChat, '合同.pdf') ===
    `${sampleAccount}/${sampleChat}/${FILES_SEGMENT}/合同.pdf`,
)
// 会话ID 来自页面（`msg.id.remote`），因此是**不可信输入**，与账号名走同一条净化纪律；
// 分不出是哪条会话时统一回落到 unknown-chat（[ADR-0055]）。
check(
  '会话ID 净化：白名单之外的字符删掉（`@` 必须留下），清不干净的整条拒掉',
  normalizeChatId('18665597400@c.us') === '18665597400@c.us' &&
    normalizeChatId('120363012345678901@g.us') === '120363012345678901@g.us' &&
    normalizeChatId('a/b@c.us') === 'ab@c.us' &&
    normalizeChatId('../../etc/passwd') === null &&
    normalizeChatId('.hidden') === null &&
    normalizeChatId('   ') === null,
)
check(
  '会话目录判据：合法段 + 足够长度才算我们的容器，且同时认下 ADR-0052 的消息ID（迁移的安全边界）',
  isChatSegment(sampleChat) &&
    isChatSegment(CHAT_FALLBACK) &&
    isChatSegment(sampleLegacyMessage) &&
    isChatSegment('unknown-message') &&
    !isChatSegment('files') &&
    !isChatSegment('stuff') &&
    !isChatSegment('2026-10'),
)
// 账号那一层来自 cookie（页面写的），因此是**不可信输入**：路径分隔符与控制字符必须被剥掉，
// 否则 `join(归档目录, stored_name)` 又多一个穿越点。
check(
  '账号名净化：白名单之外的字符删掉，清不干净的整条拒掉',
  normalizeAccountKey('a/b') === 'ab' &&
    normalizeAccountKey('../../etc/passwd') === null &&
    normalizeAccountKey('.hidden') === null &&
    normalizeAccountKey('..') === null &&
    normalizeAccountKey(sampleAccount) === sampleAccount,
)
// 索引里的相对路径会被拼到归档目录后面，因此它是**路径穿越的唯一入口**（ADR-0031 引入
// stored_name，ADR-0037 让它可以带子目录）。这里的判据是纯字符串处理，能离线断言。
check(
  '索引里的相对路径走不出归档目录',
  normalizeStoredPath('../../etc/passwd') === 'etc/passwd' &&
    normalizeStoredPath('/etc/passwd') === 'etc/passwd' &&
    normalizeStoredPath(`${sampleAccount}/files/2026-10/合同.pdf`) ===
      `${sampleAccount}/files/2026-10/合同.pdf`,
)
check('拿不到账号标识时回落到 unknown-account', accountKey() === 'unknown-account')

// 迁移目标是用户在对话框里选的目录（ADR-0019），选错一个 —— 选到自己的子目录、或
// 选到上级 —— 会让搬迁变成"自我递归"或"搬完等于没搬"。这条判据是纯字符串比较，
// 因此能离线断言。
check(
  '迁移目标不能是归档目录本身或其子目录',
  !isAllowedTarget('/data/archive', '/data/archive') &&
    !isAllowedTarget('/data/archive', '/data/archive/sub'),
)
check(
  '迁移目标不能是归档目录的上级',
  !isAllowedTarget('/data/archive', '/data') && !isAllowedTarget('/data/archive', '/'),
)
check(
  '迁移目标允许同级或其它目录（前缀相同但不是子路径）',
  isAllowedTarget('/data/archive', '/data/archive2') &&
    isAllowedTarget('/data/archive', '/mnt/disk/x'),
)
// 导出的目标只挡"里"这一个方向（[ADR-0050]）：跑到归档的**上级**（`~/Documents`，归档就在
// 它下面）完全正常，而"往归档里写副本"会被淘汰纪律原样放过 —— 那些文件永久占着磁盘、谁都
// 不认领。判据放宽或收紧都会安静地做错事，因此它值得一条离线断言。
check(
  '导出的目标不能落在归档里面（含它本身），但允许在它上面',
  isInsideArchive('/data/archive', '/data/archive') &&
    isInsideArchive('/data/archive/sub', '/data/archive') &&
    !isInsideArchive('/data', '/data/archive') &&
    !isInsideArchive('/', '/data/archive') &&
    // 前缀相同但不是子路径：漏掉结尾的斜杠就会把 `/data/archive2` 误判成子目录。
    !isInsideArchive('/data/archive2', '/data/archive') &&
    !isInsideArchive('', '/data/archive'),
)

const archive = archiveDir()

/**
 * 递归列出归档目录里的**正文**与**分层容器**（相对路径）。
 *
 * 必须递归：正文在 `<账号>/<会话ID>/files/` 里（[ADR-0055]，历史上还在
 * `<账号>/<消息ID>/files/` 与 `<年>/<月>/` 里）。
 * 点开头的条目一律跳过 —— `.part-*` 是半成品、`.index.sqlite*` 是索引、`.open/` 是旧版本的
 * 影子目录，它们都不是正文，也不该被算进这里的任何一条断言。
 */
function walkArchive(dir: string, prefix = ''): { blobs: string[]; dirs: string[] } {
  const blobs: string[] = []
  const dirs: string[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue

    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`

    if (entry.isDirectory()) {
      dirs.push(relative)
      const nested = walkArchive(join(dir, entry.name), relative)
      blobs.push(...nested.blobs)
      dirs.push(...nested.dirs)
      continue
    }

    if (entry.isFile()) blobs.push(relative)
  }

  return { blobs, dirs }
}

if (existsSync(archive)) {
  check(
    `归档目录权限为 0700`,
    (statSync(archive).mode & 0o777) === 0o700,
    `实际 ${(statSync(archive).mode & 0o777).toString(8)}`,
  )

  const { blobs, dirs } = walkArchive(archive)

  /**
   * 账号 / files / 月份三层子目录也是"里面是解密后的明文"那一类（ADR-0037 / ADR-0039）：
   * 它们由落盘时的 `ensureArchiveFolder()` 建并收紧，这里回头确认那一步真的生效了。
   */
  const looseDirs = dirs.filter(
    (relative) => (statSync(join(archive, relative)).mode & 0o777) !== 0o700,
  )
  check(
    '分层子目录权限同样是 0700',
    looseDirs.length === 0,
    `${looseDirs.length} 个目录更宽：${looseDirs.slice(0, 3).join(', ')}`,
  )

  // 残留的临时文件说明上次进程是被 kill 的（正常退出不会留下）。
  // 它不是错误 —— 下次启动会清扫掉 —— 但知道这件事有助于解释磁盘占用。
  // 只看**根**：临时文件永远落在归档根（分层容器里不会出现 `.part-*`）。
  const leftovers = readdirSync(archive).filter((name) => name.startsWith('.part-'))

  const legacyNames = blobs.filter((relative) => /^[0-9a-f]{64}$/.test(basename(relative))).length

  note(`归档目录：${archive}`)
  note(
    `正文 ${blobs.length} 个，分布在 ${dirs.length} 个子目录里${legacyNames === 0 ? '' : `（其中 ${legacyNames} 个是旧布局的哈希名，打开时会补上只读）`}`,
  )

  check(
    '没有残留的半成品',
    leftovers.length === 0,
    `${leftovers.length} 个 .part-*，下次启动会清掉`,
  )

  /**
   * 正文必须只读（ADR-0031）。
   *
   * 旧布局的正文是 64 位十六进制名，它们**豁免**这条检查：那种文件由老版本写入，
   * 本来就不是只读的，而是在被打开时懒收紧。若把它也算进来，一台老机器上这条断言
   * 会永远变红 —— 一个永远红的检查等于没有检查。
   */
  const legacy = (relative: string): boolean => /^[0-9a-f]{64}$/.test(basename(relative))
  const writable = blobs.filter(
    (relative) =>
      !legacy(relative) && (statSync(join(archive, relative)).mode & 0o777) !== ARCHIVE_FILE_MODE,
  )

  check(
    '新的正文都是只读的（0400）',
    writable.length === 0,
    `${writable.length} 个文件可写：归档被就地改写会让索引里的哈希与内容不再相符`,
  )
} else {
  note(`归档目录尚未创建（首次接管时才建）：${archive}`)
}

const cache = ciphertextCacheDir()
if (existsSync(cache)) {
  // 条目在 `<缓存根>/<账号>/<年-月>/` 里（ADR-0039），因此要按目录树数，不能只数根下。
  const months = cacheEntryDirs()
  const bins = months.reduce(
    (total, dir) => total + readdirSync(dir).filter((name) => name.endsWith(BODY_SUFFIX)).length,
    0,
  )

  note(`密文缓存：${bins} 项，分布在 ${months.length} 个月份目录里，位于 ${cache}`)
} else {
  note(`密文缓存尚未创建：${cache}`)
}

note(`索引数据库：${indexDbPath()}${existsSync(indexDbPath()) ? '' : '（尚未创建）'}`)

// ---------------------------------------------------------------------------
// 5. 缓存回放带哪些响应头
// ---------------------------------------------------------------------------
//
// 这一层漏掉一个头的症状是"页面局部坏掉、而且不报错"—— 实测缺 COEP 时，文档预览这个
// 被嵌子文档会被判为不可嵌入，页面回 `ERR_BLOCKED_BY_RESPONSE`（见 ADR-0016）。
// 因此把几条不能少、以及几条绝不能有的头固化成断言。

section('缓存回放的响应头')

check('保留跨源嵌入策略（COEP）', CARRIED_HEADERS.includes('cross-origin-embedder-policy'))
check('保留跨源打开策略（COOP）', CARRIED_HEADERS.includes('cross-origin-opener-policy'))
check('保留跨源资源策略（CORP）', CARRIED_HEADERS.includes('cross-origin-resource-policy'))
check('保留正文类型', CARRIED_HEADERS.includes('content-type'))

// 正文来自 `net.fetch`，按 fetch 语义已经是解码后的字节；回放 `content-encoding` 会让
// 浏览器再解一次。这两条是白名单存在的另一个理由。
check('绝不回放 content-encoding', !CARRIED_HEADERS.includes('content-encoding'))
check('绝不回放 set-cookie', !CARRIED_HEADERS.includes('set-cookie'))

const picked = carriedHeaders(
  new Headers({
    'content-type': 'application/octet-stream',
    'cross-origin-embedder-policy': 'require-corp',
    'set-cookie': 'a=b',
    date: 'Thu, 01 Jan 1970 00:00:00 GMT',
  }),
)
check(
  '按语义挑选（带 COEP、不带 set-cookie / date）',
  picked['cross-origin-embedder-policy'] === 'require-corp' &&
    !('set-cookie' in picked) &&
    !('date' in picked),
  JSON.stringify(picked),
)

// ---------------------------------------------------------------------------
// 6. 非官方声明在位
// ---------------------------------------------------------------------------
//
// INV-4 要求的"强制义务"：非官方声明必须同时出现在 README、DISCLAIMER 与**安装产物**
// 里。三条里前两条靠人守，第三条（产物的描述与桌面条目）最容易在改配置时被顺手删掉，
// 而用户装完之后可能永远不会打开 README —— 所以这里把它变成断言。
//
// 用绝对路径读：自检可能在任意工作目录下被调用（IDE 任务、hook）。

section('非官方声明（INV-4）')

const source = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8')

const readme = source('../README.md')
check(
  'README 的显著位置有"个人自用 + 非官方"声明',
  readme.includes('个人自用') && readme.includes('非官方'),
)
check('README 的声明在文件顶部（前 600 字符内）', readme.slice(0, 600).includes('非官方'))

const disclaimer = source('../DISCLAIMER.md')
check(
  'DISCLAIMER 声明了与官方无隶属关系',
  disclaimer.includes('非官方') && disclaimer.includes('没有任何隶属'),
)

// 这两条是"安装产物中"的那一份：synopsis 进 deb 的 control，Comment 进 .desktop。
const builderConfig = source('../electron-builder.yml')
check('deb synopsis 含 unofficial', /^\s*synopsis:.*[Uu]nofficial/m.test(builderConfig))
check('.desktop 的 Comment 含 unofficial', /^\s*Comment:.*[Uu]nofficial/m.test(builderConfig))

// ---------------------------------------------------------------------------
// 7. 自定义图标
// ---------------------------------------------------------------------------
//
// 这一层的坏结果全都不报错：图标被拉伸变形、启动器那份条目漏掉非官方声明、
// 图标文件被别人读写。因此把几条约定固化成断言。
//
// 不覆盖的部分（**故意**）：真实的解码与裁剪发生在渲染进程的 canvas 里，
// 离线状态下没有 DOM 可跑，因此那一步只能靠一次真实的点击来验证。

section('自定义图标')

check(
  '接受 png / jpg / ico（需求点名了这三种）',
  ['png', 'jpg', 'ico'].every((extension) => isAcceptedIconName(`icon.${extension}`)),
)
check('拒绝会承载脚本的 svg', !isAcceptedIconName('icon.svg'))
check(`产出尺寸不小于 256（当前 ${APP_ICON_SIZE}）`, APP_ICON_SIZE >= 256)

const crop = coverCropRect(1600, 900)
check(
  '非等比图片裁成正方形且不越界',
  crop !== null && crop.x + crop.size <= 1600 && crop.y + crop.size <= 900,
  JSON.stringify(crop),
)

// 不加引号时，含空格的路径会被桌面条目拆成"命令 + 参数"，症状是从启动器点开没反应。
check('Exec 里含空格的路径会被引号化', desktopEntryExec('/a b/c').startsWith('"'))

const launcherEntry = buildDesktopEntry({
  name: 'WaaChat',
  exec: '/opt/WaaChat/waachat',
  iconPath: '/home/edwin/.config/waachat/custom-icon.png',
  startupWMClass: APP_ID,
})
check('启动器条目带着"本应用生成"的标记', launcherEntry.includes(DESKTOP_ENTRY_MARKER))
check('启动器条目保留非官方声明（INV-4）', /unofficial/i.test(launcherEntry))
check(
  '启动器条目的 Comment 与 electron-builder.yml 同文（改一处必须改另一处）',
  builderConfig.includes(`Comment: ${DESKTOP_ENTRY_COMMENT}`),
)
check(
  '启动器条目的 StartupWMClass 与 appId 同源',
  launcherEntry.includes(`StartupWMClass=${APP_ID}`),
)
check(
  '两份 .desktop 都带 StartupNotify=false（[ADR-0095]：否则点页面通知后光标空转约 15 秒）',
  // 用户换过图标之后，用户级那份会盖掉安装产物那份 —— 只在 electron-builder.yml 里加不够。
  launcherEntry.includes('StartupNotify=false\n') && builderConfig.includes('StartupNotify: false'),
  '漏一处：换过图标的用户点通知之后，鼠标仍会转圈约 15 秒（不报错）',
)

/**
 * 下面两条只有在用户真的设过自定义图标之后才有意义。
 *
 * 权限是 0600 的硬要求：图标本身不敏感，但它与归档、日志并排放在同一个用户目录里，
 * 没有必要让同机其它用户读它 —— 与归档目录 0700 是同一条理由。
 */
const customIcon = join(homedir(), '.config', 'waachat', CUSTOM_ICON_FILENAME)
if (existsSync(customIcon)) {
  check(
    '自定义图标权限为 0600',
    (statSync(customIcon).mode & 0o777) === 0o600,
    `实际 ${(statSync(customIcon).mode & 0o777).toString(8)}`,
  )
  note(`自定义图标：${customIcon}`)
} else {
  note(`尚未设置自定义图标（设置后落在 ${customIcon}）`)
}

const dataHome = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
const launcherOverride = join(dataHome, 'applications', DESKTOP_FILE_NAME)
if (existsSync(launcherOverride)) {
  const text = readFileSync(launcherOverride, 'utf8')
  check('用户级启动器条目是本应用写的', text.includes(DESKTOP_ENTRY_MARKER))
  check('用户级启动器条目保留非官方声明（INV-4）', /unofficial/i.test(text))
  note(`启动器条目覆盖：${launcherOverride}`)
} else {
  note(`尚未写用户级启动器条目（设置自定义图标时会写到 ${launcherOverride}）`)
}

// ---------------------------------------------------------------------------
// 8. 密文缓存的开关约定
// ---------------------------------------------------------------------------
//
// 这几条都属于"改了没人会立刻发现"的约定：
//   - 默认值被改回关闭，会让"第二次打开还要联网"重新成为默认体验 —— 而缓存里存的始终是
//     上游已经加密好的密文（ADR-0028 / INV-3），默认不该退回到那一侧；
//   - 它**不能**再回到"重启后生效"名单里：切换是事务式的（ADR-0027），提交即生效。
//     一旦有人把它加回去，界面会显示"重启后生效"，而实际提交就已经生效了 —— 两边打架。
//   - 暂存区以点开头、且不被当成缓存条目：它是转换期间的可回滚存放处，若被 `isEntryName()`
//     认成条目，对账就会把它连内容一起"清掉"，回滚能力当场消失。

section('密文缓存的开关约定')

check('默认开启', DEFAULT_SETTINGS.enableCiphertextCache === true)
check(
  '不在"重启后生效"名单里（切换是事务式的，提交即生效）',
  !RESTART_REQUIRED_SETTINGS.includes('enableCiphertextCache'),
)
check('暂存区不会被当成缓存条目', !isEntryName(STAGING_DIR_NAME))
check('暂存区是隐藏目录（对账的"混进来的东西"里不含它）', STAGING_DIR_NAME.startsWith('.'))

// ---------------------------------------------------------------------------
// 9. 网络：值得重试的错误
// ---------------------------------------------------------------------------
//
// 判据锁在**实测到的形状**上：fetch 失败抛出的 Error 只有 message 里的 `net::ERR_…`，
// 没有 code / errno 可读（见 ADR-0033 的实测表）。白名单放宽会把证书错误也算成"可重试"
// —— 那等于把真正的原因伪装成偶发抖动；收紧则会让网络抖动救不回来。

section('网络：值得重试的错误')

check(
  '连接被重置 / 被对端关闭可重试（用户日志里的 net_error -101 是第一类）',
  isTransientNetworkError(new Error('net::ERR_CONNECTION_RESET')) &&
    isTransientNetworkError(new Error('net::ERR_CONNECTION_CLOSED')),
)
check(
  '证书问题不重试（重试不会改变结论）',
  !isTransientNetworkError(new Error('net::ERR_CERT_AUTHORITY_INVALID')),
)
check(
  '主动取消与非网络错误不重试',
  !isTransientNetworkError(new Error('net::ERR_ABORTED')) &&
    !isTransientNetworkError(new TypeError('fetch failed')),
)
check(
  '日志里只写错误码，不写完整消息',
  describeNetworkError(new Error('net::ERR_CONNECTION_RESET 发生在 https://x/y?token=1')) ===
    'net::ERR_CONNECTION_RESET',
)
check(
  `重试有上限：最多 ${MAX_ATTEMPTS} 次尝试（网络被阻断时不能变成"一直加载中"）`,
  MAX_ATTEMPTS === 3,
)
check('退避带抖动且有上界', nextDelayMs(1, () => 1) <= 400 && nextDelayMs(2, () => 1) <= 1200)

// ---------------------------------------------------------------------------
// 10. 权限白名单（安全关键）
// ---------------------------------------------------------------------------
//
// 判据在 `src/main/permissions.ts`（不导入 electron，因此这里能直接断言它）。
// 它的失手方式很安静：放宽一项既不报错也没有症状 —— 只会让某个第三方页面拿到摄像头，
// 或者少一行 `permission denied` 日志（见 ADR-0035 与 docs/security.md T5）。

section('权限白名单')

/** 上游源 —— 白名单的两半（来源 + 类型）里"来源"那一半的基准。 */
const UPSTREAM_ORIGIN = 'https://web.whatsapp.com/'

check(
  '上游源可以申请放行的那几项',
  isPermissionAllowed('media', 'https://web.whatsapp.com/') &&
    isPermissionAllowed('notifications', 'https://web.whatsapp.com/') &&
    // 它不授予任何能力，只影响本分区数据的淘汰策略；拒绝它可能换来一次重新扫码。
    isPermissionAllowed('persistent-storage', 'https://web.whatsapp.com/'),
)
check(
  '来源错了就拒绝（前缀骗术不算同一个源）',
  !isPermissionAllowed('media', 'https://web.whatsapp.com.evil.com/') &&
    !isPermissionAllowed('media', 'https://web.whatsapp.com@evil.com/') &&
    !isPermissionAllowed('media', ''),
)
check(
  '读剪贴板 / 位置 / 屏幕捕获一律拒绝',
  !isPermissionAllowed('clipboard-read', 'https://web.whatsapp.com/') &&
    !isPermissionAllowed('geolocation', 'https://web.whatsapp.com/') &&
    !isPermissionAllowed('display-capture', 'https://web.whatsapp.com/'),
)
check(
  '未知权限默认拒绝（白名单的意义）',
  !isPermissionAllowed('some-future-permission', 'https://web.whatsapp.com/'),
)
check(
  `放行的类型恰好 ${String(ALLOWED_PERMISSIONS.size)} 项（加一项要改断言，也就必须说清理由）`,
  ALLOWED_PERMISSIONS.size === 5,
)

/**
 * 拒绝日志的簿记（[ADR-0085]）。
 *
 * 这三条守的是"取证"这件事本身：判据放宽需要证据（[ADR-0035] 的取证清单），而证据只能来自
 * 日志。日志坏掉有两种相反的方式 —— 被重复行挤掉，或者少记了一条路（有些 API **只检查不请求**，
 * 那种情形下"检查被拒"是唯一的信号）。
 */
const persistedCheck = denialKey({
  path: 'check',
  permission: 'persistent-storage',
  fromUpstream: true,
})

/**
 * `session.ts` 在这里**单独读一份**：下面几节那个 `sessionSource` 在这一节之后才声明，而这几条
 * 断言要跟着权限判据走（它们守的是同一件事：判据放宽需要证据，而证据只能从日志里来）。
 */
const permissionSessionSource = source('../src/main/session.ts')

check(
  '拒绝日志会去重（内核反复检查同一项时不该逐条记，否则真正有用的那几行会被挤掉）',
  trackDenial(new Set(), { path: 'check', permission: 'persistent-storage', fromUpstream: true })
    .log &&
    !trackDenial(new Set([persistedCheck]), {
      path: 'check',
      permission: 'persistent-storage',
      fromUpstream: true,
    }).log,
  '去重失效 —— 取证时会在一堆重复行里找不到那句"上游第一次请求了什么"',
)
check(
  '两条路各留各的痕：**检查**被拒也记（有些 API 只检查、不请求）',
  permissionSessionSource.includes("reportDenial('request'") &&
    permissionSessionSource.includes("reportDenial('check'") &&
    permissionSessionSource.includes("'permission check denied'"),
  '检查那条路没留痕 —— 症状是"用户报点了没反应、而日志里一片干净"，我们会去别处找原因',
)
check(
  '键里带着三个维度（一次第三方检查不该把上游那条真正的证据静音）',
  trackDenial(
    new Set([denialKey({ path: 'check', permission: 'display-capture', fromUpstream: false })]),
    {
      path: 'request',
      permission: 'display-capture',
      fromUpstream: true,
    },
  ).log,
  '键里少了维度 —— 第三方检查过同一项权限，上游那次真正的请求就不再出现在日志里',
)

// ---------------------------------------------------------------------------
// 11. Linux 启动期的 GPU 开关
// ---------------------------------------------------------------------------
//
// 只在**走 Wayland 的臭氧路径**时不再请求 Vulkan（那行 `wayland_surface_factory.cc … not
// compatible with Vulkan` 的来历与两层开关的分工见 ADR-0036 / ADR-0038）。
// 四条边界都属于"改坏了没人会立刻发现"：判据放宽会在 X11 上白关一次；覆盖 `--disable-features`
// 会静默抹掉用户自己的列表；忽略用户的显式要求等于替他做决定；而**少关一个开关**就等于那行
// ERROR 照旧出现（1.0.3 实测踩过：只关 feature 不够）。

section('Linux 启动期的 GPU 开关')

/** 与 `app.commandLine` 同形的假对象 —— 自检不该真的改这个进程的开关。 */
function fakeCommandLine(switches: Record<string, string> = {}): CommandLineLike {
  const current = { ...switches }

  return {
    getSwitchValue: (name) => current[name] ?? '',
    appendSwitch: (name, value) => {
      current[name] = value
    },
  }
}

check(
  'Wayland 上不请求 Vulkan（GL / 合成那一层）',
  applyLinuxGpuSwitches(fakeCommandLine(), { waylandDisplay: 'wayland-0' }),
)
check(
  // 只关 feature 是**不够的**：那行报错的真正来源是 WebGPU 的「原生 Vulkan + GL 互操作」，
  // 它不是一个 `base::Feature`（实测：1.0.3 的 GPU 进程带着 disable-features 也照旧报）。
  'Wayland 上把 WebGPU 也从原生 Vulkan 上挪开（否则那行 ERROR 依旧）',
  (() => {
    const cli = fakeCommandLine()
    applyLinuxGpuSwitches(cli, { waylandDisplay: 'wayland-0' })

    return cli.getSwitchValue('use-webgpu-adapter') === 'opengles'
  })(),
)
check(
  '用户自己指定了 WebGPU 后端时不动它（逃生通道）',
  (() => {
    const cli = fakeCommandLine({ 'use-webgpu-adapter': 'vulkan' })
    applyLinuxGpuSwitches(cli, { sessionType: 'wayland' })

    return cli.getSwitchValue('use-webgpu-adapter') === 'vulkan'
  })(),
)
check(
  'X11 上不碰命令行（那边 Vulkan 可能真的可用）',
  !applyLinuxGpuSwitches(fakeCommandLine(), { sessionType: 'x11' }) &&
    !applyLinuxGpuSwitches(fakeCommandLine({ 'ozone-platform': 'x11' }), {
      waylandDisplay: 'wayland-0',
    }) &&
    (() => {
      const cli = fakeCommandLine()
      applyLinuxGpuSwitches(cli, { sessionType: 'x11' })

      return cli.getSwitchValue('use-webgpu-adapter') === ''
    })(),
)
check(
  '用户显式要求 Vulkan 时不动',
  !applyLinuxGpuSwitches(fakeCommandLine({ 'enable-features': 'Vulkan' }), {
    sessionType: 'wayland',
  }),
)
check(
  '与用户已有的 --disable-features 合并，而不是覆盖',
  (() => {
    const cli = fakeCommandLine({ 'disable-features': 'UserFeature' })
    applyLinuxGpuSwitches(cli, { sessionType: 'wayland' })

    return cli.getSwitchValue('disable-features').startsWith('UserFeature,Vulkan')
  })(),
)
check('拿不准时不动作（既没有开关也没有会话信息）', !usesWaylandOzone({ ozonePlatform: '' }))

// ---------------------------------------------------------------------------
// 12. 容量上限的状态与所在区域
// ---------------------------------------------------------------------------
//
// 两层断言。
//
// **状态**：两项上限**今天都已经会被执行**（归档 = `store.enforceLimit()`，[ADR-0048]；
// 缓存 = `enforceCacheLimit()`，[ADR-0049]）—— 界面上那两行必须如实说出来。反过来，把
// "尚未生效"钉死在没有上限的配置上同样是错的 —— 默认的 `archiveMaxBytes` 就是 0（不限制），
// 而"不限制"恰恰是**正在照配置执行**的那一种：它字面意思就是不清理。徽标只在"设了上限却
// 不会被执行"时出现，因此下面两条"未实现"分支的断言要**显式传 `false`** 才能构造出来。
//
// **区域**：容量项必须与它管辖的那个开关在同一个区域里（"2 GB"离开开关就读不懂它是给谁
// 设的上限），且每个设置项恰好有一行 —— 漏掉一个等于它在界面上消失，而那是没人会发现的
// 一类坏结果。

section('容量上限的状态与所在区域')

const GB = 1024 * 1024 * 1024

check(
  '不限制时不打"尚未生效"徽标（否则提示与配置无关）',
  (() => {
    const state = describeSizeLimit('archiveMaxBytes', 0, false)

    return state.badge === null && state.unlimited && state.inputValue === ''
  })(),
)
check(
  '设了上限但淘汰未实现时：徽标 + 说清后果（不是只说"不生效"）',
  (() => {
    const state = describeSizeLimit('archiveMaxBytes', 50 * GB, false)

    return (
      state.badge === '尚未生效' &&
      state.hint.includes('50 GB') &&
      state.hint.includes('会一直增长')
    )
  })(),
)
check(
  '实现之后徽标消失、提示换成"超过之后会发生什么"（改一个布尔值就够）',
  (() => {
    const state = describeSizeLimit('archiveMaxBytes', 50 * GB, true)

    return state.badge === null && !state.hint.includes('尚未实现')
  })(),
)
check(
  '配置被改坏（负数 / NaN）时按"不限制"处理，而不是当成一个荒谬的上限',
  describeSizeLimit('cacheMaxBytes', Number.NaN, false).unlimited &&
    describeSizeLimit('cacheMaxBytes', -1, false).unlimited,
)
check(
  '当前事实与文档一致：两项上限都已执行（任一退回未实现，这条会红）',
  SIZE_LIMIT_ENFORCED.archiveMaxBytes && SIZE_LIMIT_ENFORCED.cacheMaxBytes,
)

const cacheSection = sectionOfRow('cacheMaxBytes')
check(
  '密文缓存上限与密文磁盘缓存在同一个区域，且紧跟其后',
  cacheSection !== null &&
    cacheSection === sectionOfRow('enableCiphertextCache') &&
    cacheSection.rows.indexOf('cacheMaxBytes') ===
      cacheSection.rows.indexOf('enableCiphertextCache') + 1,
)
check(
  '归档大小上限与文件保存位置在同一区域',
  sectionOfRow('archiveMaxBytes') !== null &&
    sectionOfRow('archiveMaxBytes') === sectionOfRow('archiveDir'),
)
check(
  '每个设置项恰好有一行，且每个区域都有标题（漏一行等于它在界面上消失）',
  SETTINGS_ROW_ORDER.length === Object.keys(DEFAULT_SETTINGS).length + EXTRA_SETTINGS_ROWS.length &&
    new Set(SETTINGS_ROW_ORDER).size === SETTINGS_ROW_ORDER.length &&
    SETTINGS_SECTIONS.every((section) => section.title.trim() !== '' && section.rows.length > 0),
)
check('「关于」是最后一行（它是只读的说明，不是设置项）', SETTINGS_ROW_ORDER.at(-1) === 'about')

// ---------------------------------------------------------------------------
// 13. 设置窗口的按钮样式
// ---------------------------------------------------------------------------
//
// 动作按钮（"选择图片…" / "恢复默认" / "更改…"）的外观只有两样东西：`shared/action-button.ts`
// 里的 class 名，与 `styles.css` 里那条规则。两者对不上时**没有任何报错** —— 按钮只是突然
// 变成浏览器默认样式，而"系统里看着有点不一样"不会有人当 bug 报。因此这里把那个连接钉住：
// 基础规则、悬停效果、禁用态三条都必须在样式表里。
//
// 属性那一半（两处按钮除文字外完全一致）见 `test/unit/action-button.test.ts`。

section('设置窗口的按钮样式')

const stylesheet = readFileSync(
  fileURLToPath(new URL('../src/renderer/styles.css', import.meta.url)),
  'utf8',
)

check(
  '动作按钮的 class 在样式表里有定义（改名却忘改 CSS 会让按钮静默失去外观）',
  stylesheet.includes(`button.${ACTION_BUTTON_CLASS} {`) ||
    stylesheet.includes(`button.${ACTION_BUTTON_CLASS},`),
  `styles.css 里找不到 button.${ACTION_BUTTON_CLASS} 的基础规则`,
)
check(
  '悬停与禁用态也定义在同一处（两处按钮因此共用同一套交互反馈）',
  stylesheet.includes(`button.${ACTION_BUTTON_CLASS}:hover`) &&
    stylesheet.includes(`button.${ACTION_BUTTON_CLASS}[disabled]`),
)

// 批量操作那几样东西的样式（[ADR-0050] / [ADR-0053]）：类名写在文件列表的 HTML 与视图里，
// 样式表里改了名**不会有任何报错** —— 复选框只是突然变成浏览器默认大小、已选条数忽然挤在
// 搜索框旁边。与上面 `button.action` 同一条理由。
check(
  '批量操作的样式在样式表里有定义（勾选框 / 全选 / 已选条数）',
  stylesheet.includes('.pick-all {') &&
    stylesheet.includes('.selection {') &&
    stylesheet.includes('ul.archive li .pick {'),
  'styles.css 里找不到批量操作的那几条规则',
)

// 结果行必须**独立**于统计行（[ADR-0050] 决定 9）：共用一个元素时，结果刚写完就被紧随其后的
// `refresh()` 用统计覆盖，于是"打开失败"这类提示事实上从未被人看见过（违反 CONVENTIONS 第 4 节）。
// 而多行文案还依赖 `pre-line`，否则逐条失败会被折成一堵墙。
check(
  '结果行是独立元素，且保留换行（多行文案依赖 pre-line）',
  stylesheet.includes('p.status {') && stylesheet.includes('white-space: pre-line'),
)

// ---------------------------------------------------------------------------
// 14. 接管失效必须可见
// ---------------------------------------------------------------------------
//
// `architecture.md` 第 5 节：**允许失效，不允许静默失效**。设置窗口那条顶栏去掉之后
// （ADR-0042），界面告知的唯一渠道是系统通知 —— 因此"什么情况下会弹"这条判据属于"改了没人会
// 立刻发现"的那一类：弹得太勤，用户会把通知关掉（之后真正需要的提示也看不到）；永远不弹，
// 等于那条不变量被悄悄删掉。设置项与渲染层不再有任何"接管状态"显示，这条断言就是它的看守。

section('接管失效必须可见')

check(
  '每种失效提示一次，接管恢复正常后重新武装',
  (() => {
    const failed = trackCaptureFailure(new Set(), { kind: 'write-failed', reason: 'ENOSPC' })
    const healthy = trackCaptureFailure(failed.announced, null)

    return (
      failed.announce &&
      !trackCaptureFailure(failed.announced, { kind: 'write-failed', reason: 'x' }).announce &&
      trackCaptureFailure(failed.announced, { kind: 'too-large', bytes: 1 }).announce &&
      healthy.announced.size === 0 &&
      trackCaptureFailure(healthy.announced, { kind: 'write-failed', reason: 'x' }).announce
    )
  })(),
)
check(
  '失效提示的正文与界面共用同一份人话（不再有别的显示渠道）',
  captureFailureBody({ kind: 'too-large', bytes: 1 }).includes('上限'),
)

// ---------------------------------------------------------------------------
// 15. INV-3：不经手密钥与加密
// ---------------------------------------------------------------------------
//
// 接入 `whatsapp-web.js` 之前必须回答一个问题："解密还在不在我们手里"。抽样审计的结论是
// **在** —— 解密由上游页面代码（`msg.downloadMedia()`）完成，该库自身不含对称解密实现，
// 逐条证据见 `docs/research/inv3-assessment.md`（该文件同时写明结论何时作废）。
//
// 那条结论有一个前提：**我们自己不去实现它**。本节就是那个前提的看守 —— 断言 `src/` 下
// 不出现解密原语与密钥字段。lint 拦"写法"，这里拦"结果"；而依赖那一半（在 **Node 侧**解密
// 的库会让解密离开上游）只能在这里对依赖清单断言，因为它的调用点可能只有一行。

section('INV-3：不经手密钥与加密')

/**
 * 禁用标识符。`createHash` **不**在此列 —— 对明文算 sha256 用于内容寻址是 INV-3 明确允许的
 * 例外（`archive/blobs.ts`）。
 *
 * `filehash` 也**已移出**（[ADR-0047](../docs/decisions.md)）：真机实测表明客户端模型的
 * `msg.filehash` 是**文件明文的 SHA-256**（与归档 `hash` 相同），不是密钥派生的 HMAC。
 * `mediaKey` 与解密原语不在放宽之列。
 */
const FORBIDDEN_CRYPTO_TOKENS = [
  'createDecipheriv',
  'createDecipher',
  'createCipheriv',
  'createCipher',
  'createHmac',
  'hkdf',
  'crypto.subtle',
  'mediaKey',
]

/**
 * 剥掉注释再扫：注释里提到这些词是**允许**的（文档需要解释"为什么不做"）。这个剥离是粗糙的
 * （字符串里的 `//` 会被误剥），对一条守卫来说够了 —— 它要抓的是真实调用，不是精确解析。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)

    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

const srcRoot = fileURLToPath(new URL('../src', import.meta.url))
const srcFiles = sourceFiles(srcRoot)
const cryptoOffenders: string[] = []

for (const file of srcFiles) {
  const code = stripComments(readFileSync(file, 'utf8'))
  for (const token of FORBIDDEN_CRYPTO_TOKENS) {
    if (code.includes(token)) cryptoOffenders.push(`${basename(file)}:${token}`)
  }
}

check(
  `src/ 下不出现解密原语或密钥字段（${FORBIDDEN_CRYPTO_TOKENS.length} 个禁用标识符）`,
  cryptoOffenders.length === 0,
  cryptoOffenders.join(', '),
)
check(
  '内容寻址用的 sha256 仍然在用（这条不是禁令的一部分，别把例外一起禁掉）',
  srcFiles.some((file) => readFileSync(file, 'utf8').includes("createHash('sha256')")),
)

// 依赖纪律：这些库在 **Node 侧**自己做解密，会直接让"解密只由官方页面代码完成"不成立。
// INV-2 的 lint 守卫（eslint.config.mjs 的 projectGuards）在源码层拦协议库，这里再加一道
// 对 **运行时依赖** 的断言 —— 两道互补：lint 拦"写法"，自检拦"结果 + 依赖"。
const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { dependencies?: Record<string, string> }

const NODE_SIDE_DECRYPTERS = ['baileys', '@whiskeysockets/baileys', 'whatsmeow']
const installedDecrypters = Object.keys(packageJson.dependencies ?? {}).filter((name) =>
  NODE_SIDE_DECRYPTERS.some((bad) => name === bad || name.startsWith(`${bad}/`)),
)

check(
  '依赖里没有在 Node 侧解密的库（它们会让解密离开上游页面代码）',
  installedDecrypters.length === 0,
  installedDecrypters.join(', '),
)
note('解密由上游页面代码完成：证据与作废条件见 docs/research/inv3-assessment.md')

// ---------------------------------------------------------------------------
// 16. "未实现的项必须不可改"这条约定今天还剩几项
// ---------------------------------------------------------------------------
//
// 设置窗口里每个控件都必须对得起它写的那句话：**能改的就一定真的会被执行**，否则要么禁用它
// （容量项看 `SIZE_LIMIT_ENFORCED`、开关看 `ToggleSpec.enforced`），要么明确标注未实现。
//
// 今天只剩「后台预取文档」一项没实现，而它的判据不是"代码里有没有 TODO"，而是**有没有读者**：
// `Settings.prefetch` 在主进程里一次都不出现。这条断言因此是**故意会过期**的 —— 预取落地时
// 它会变红，提醒把界面上那个开关解除禁用、并同步 docs/usage.md 与路线图。

section('未实现的设置项')

const mainRoot = fileURLToPath(new URL('../src/main', import.meta.url))
const prefetchReaders = sourceFiles(mainRoot).filter((file) =>
  readFileSync(file, 'utf8').includes('prefetch'),
)

check(
  '「后台预取文档」确实还没有任何读者（界面上因此必须禁用并写明未实现）',
  prefetchReaders.length === 0,
  prefetchReaders.map((file) => basename(file)).join(', '),
)

// ---------------------------------------------------------------------------
// 17. 直通重发补回的 fetch 元数据
// ---------------------------------------------------------------------------
//
// 会话级协议层把所有 https 请求都接住之后，非媒体的那些只能靠 `ses.fetch` 重发 —— 而重发出去的
// 那一份会被内核当成"主进程发起的、没有上下文的请求"（`Sec-Fetch-*` 退化、`Referer` 丢失）。
// 上游文档预览页按 `Sec-Fetch-Site` / `Sec-Fetch-Mode` 决定回哪一份变体，拿到无上下文的那一份
// 就**没有** `cross-origin-resource-policy`，在 COEP 父文档里被判"不可嵌入" ⇒
// `ERR_BLOCKED_BY_RESPONSE` ⇒ 预览面板一直转圈（见 [ADR-0058]）。
//
// 症状同样属于"页面局部坏掉、不报错"，而且只在协议层挂着、且真的要回源时才出现。因此把角色
// 换算与几条"绝不能有"固化成断言 —— 与第 5 节的响应头是同一类问题（改了没人会立刻发现）。

section('直通重发补回的 fetch 元数据')

check(
  '子框架导航补成 navigate / iframe（文档预览缺的就是这一条）',
  FETCH_METADATA_BY_RESOURCE_TYPE.subFrame.mode === 'navigate' &&
    FETCH_METADATA_BY_RESOURCE_TYPE.subFrame.dest === 'iframe',
)
check(
  '顶层导航补成 navigate / document，且只有它带 Sec-Fetch-User',
  FETCH_METADATA_BY_RESOURCE_TYPE.mainFrame.dest === 'document' &&
    FETCH_METADATA_BY_RESOURCE_TYPE.mainFrame.user === '?1' &&
    FETCH_METADATA_BY_RESOURCE_TYPE.subFrame.user === undefined,
)

// 换算表的取值有两条**内核侧的硬校验**（Electron 44.7 实测，见 ADR-0058）：
//  - `Sec-Fetch-Mode` 只能是 `navigate` / `no-cors`：带上 `cors` / `same-origin` 的那一份
//    请求**根本发不出去**，直接以 `net::ERR_INVALID_ARGUMENT` 失败（终端里只有一行 stderr）；
//  - `dest` 是框架类（document / frame / iframe / fencedframe）时必须配 `navigate`。
// 前者是真实踩过的坑：`xhr` 曾经被补成 `cors`/`empty`，于是分区里每一个 XHR / `fetch()` 全挂。
const metadataEntries = Object.entries(FETCH_METADATA_BY_RESOURCE_TYPE)
const ACCEPTED_MODES = new Set(['navigate', 'no-cors'])
const FRAME_DESTS = new Set(['document', 'frame', 'iframe', 'fencedframe'])

const badModes = metadataEntries
  .filter(([, value]) => !ACCEPTED_MODES.has(value.mode))
  .map(([role, value]) => `${role}:${value.mode}`)
check(
  '每个角色的 mode 都是内核接受的取值（cors / same-origin 会让请求直接失败）',
  badModes.length === 0,
  badModes.join(', '),
)

const badPairs = metadataEntries
  .filter(([, value]) => FRAME_DESTS.has(value.dest) && value.mode !== 'navigate')
  .map(([role]) => role)
check(
  '框架类 dest 必须配 navigate（内核的硬校验，配错同样是请求发不出去）',
  badPairs.length === 0,
  badPairs.join(', '),
)

// 这三条是"绝不能有"：`other` 正是我们自己重发出去的那一份，收录它等于队列自己喂自己；
// `media` 的 dest 在 video / audio 之间分不出来；`xhr` 的真浏览器取值是被内核拒收的 `cors`
// —— 三者都只能维持内核默认（对 `xhr` 而言那恰好就是 `no-cors`/`empty`）。
check('不收录 other（否则重发的那一份会重新进队列）', !('other' in FETCH_METADATA_BY_RESOURCE_TYPE))
check(
  '不收录 media（dest 分不出来，宁可维持内核默认）',
  !('media' in FETCH_METADATA_BY_RESOURCE_TYPE),
)
check(
  '不收录 xhr（真浏览器发 cors，而 cors 会被内核拒收：收录它等于把每个 XHR 都打掉）',
  !('xhr' in FETCH_METADATA_BY_RESOURCE_TYPE),
)

const previewUrl = 'https://webtp.whatsapp.net/pdf-viewer/?locale=zh_CN'

clearRequestContexts()
rememberRequestContext({
  method: 'GET',
  url: previewUrl,
  resourceType: 'subFrame',
  referrer: 'https://web.whatsapp.com/',
})

const previewRequest = new Request(previewUrl)
applyRequestContext(previewRequest)
check(
  '按角色补回 Sec-Fetch-* 与 Referer，且不碰 Sec-Fetch-Site（内核现算，写了也会被覆盖）',
  previewRequest.headers.get('Sec-Fetch-Mode') === 'navigate' &&
    previewRequest.headers.get('Sec-Fetch-Dest') === 'iframe' &&
    previewRequest.headers.get('Referer') === 'https://web.whatsapp.com/' &&
    previewRequest.headers.get('Sec-Fetch-Site') === null,
)

// 取不到记录时不许把请求写坏：`new Request(url)` 的默认 `referrer` 是哨兵值 `about:client`，
// 它不是一个地址 —— 写进 `Referer` 会造出一份畸形请求。
clearRequestContexts()
const bareRequest = new Request('https://example.com/x')
applyRequestContext(bareRequest)
check(
  '取不到记录时不写坏请求（不把 about:client 写成 Referer，也不编 Sec-Fetch-*）',
  bareRequest.referrer === 'about:client' &&
    bareRequest.headers.get('Referer') === null &&
    bareRequest.headers.get('Sec-Fetch-Mode') === null,
)

// 角色与请求一一对应、取走即消失：否则同一 URL 的下一次重发会拿到上一次的角色（串味），
// 而"同一个 URL 并发若干请求"在加载图片时很常见。
rememberRequestContext({ method: 'GET', url: previewUrl, resourceType: 'script', referrer: '' })
const scriptRequest = new Request(previewUrl)
applyRequestContext(scriptRequest)
const reusedRequest = new Request(previewUrl)
applyRequestContext(reusedRequest)
check(
  '角色按 method + url 配对、取出即消失（不会串到下一条请求上）',
  scriptRequest.headers.get('Sec-Fetch-Mode') === 'no-cors' &&
    scriptRequest.headers.get('Sec-Fetch-Dest') === 'script' &&
    reusedRequest.headers.get('Sec-Fetch-Mode') === null,
)

// 摘掉协议层时要清空：切换会在两个方向上来回走，留着只会让下一轮的请求拿到上一轮的角色。
rememberRequestContext({ method: 'GET', url: previewUrl, resourceType: 'subFrame', referrer: '' })
clearRequestContexts()
const afterClear = new Request(previewUrl)
applyRequestContext(afterClear)
check(
  '摘掉协议层时清空队列（切换来回走，留着只会串味）',
  afterClear.headers.get('Sec-Fetch-Mode') === null,
)

// ---------------------------------------------------------------------------
// 18. 「关闭窗口 = 隐藏」不因未打包而例外
// ---------------------------------------------------------------------------
//
// 应用常驻托盘、窗口关掉还能从托盘叫回来 —— 这条契约曾经被 `hideOnClose()` 里一个
// `if (app.isPackaged === false) return` 绕开（[ADR-0059]）：开发模式下关窗口会真的销毁它，
// 而托盘菜单与托盘点击持有的是创建时捕获的那份引用 ⇒ 双击托盘 / 「显示聊天」毫无反应，
// 且不报错。症状属于"改了没人会立刻发现"的那一类，因此把这条钉住。
//
// `window.ts` 导入 electron，按 ai/CONVENTIONS.md 第 8 节不能进单测 —— 只能做文本断言。

section('关闭窗口 = 隐藏')

const windowSource = source('../src/main/window.ts')
const hideOnCloseBody = /function hideOnClose[\s\S]*?\n}/.exec(windowSource)?.[0] ?? ''
check(
  '关闭窗口一律隐藏，不因未打包而例外（否则开发模式下关掉窗口就叫不回来）',
  hideOnCloseBody.includes("window.on('close'") &&
    hideOnCloseBody.includes('event.preventDefault()') &&
    hideOnCloseBody.includes('window.hide()') &&
    !hideOnCloseBody.includes('isPackaged'),
  hideOnCloseBody === '' ? 'window.ts 里找不到 hideOnClose()' : '它里面出现了 isPackaged 分支',
)

// ---------------------------------------------------------------------------
// 19. 拼写检查与 UA
// ---------------------------------------------------------------------------
//
// 这两项都建立在**内核的既有能力**上，因此没有"接管"可以断言，风险全落在安静的失败模式上：
//
//   1. 拼写词典的码写成区域形式（`de-DE`）→ 内核拒收，勾了等于没勾，且不报错；
//   2. **两处各设一半 UA**（会话设了、窗口又设）→ 会话那一份被盖掉，而没有任何报错。
//
// 前者断言判据表本身；后者断言的是**源码**，因为那一半是"两个地方各写一行"造成的。
//
// 「界面语言」曾经也住在这一节：它那条偏好 cookie 的**写法**与**作用域**都值得钉住（[ADR-0065]）。
// [ADR-0066] 把那一项整个撤掉，连带退休了 INV-1 的**写入例外**，那批断言随之删除 ——
// "被撤掉的口子不许悄悄回来"的负向回归守卫改放在下面「立即重启」那一组里（见该节开头）。

section('拼写检查与 UA')

check(
  '拼写词典统一用基础语言码（我们的取舍）：区域码只有 en-US / en-GB / pt-BR',
  SPELLCHECK_LANGUAGES.map((entry) => entry.code)
    .filter((code) => code.includes('-'))
    .sort()
    .join(',') === 'en-GB,en-US,pt-BR',
)
// 注意这条断言的**理由**是实测出来的，不是照抄的：Electron 44.7 的清单是 57 门，
// `de` 与 `de-DE` / `fr` 与 `fr-FR` / `it` 与 `it-IT` / `es` 与 `es-ES` **都在**里面 ——
// 也就是说上一版注释里"内核不认 de-DE"那句是错的（见 ADR-0063 的"顺带纠正"）。
// 但 `zh*` 确实一个都没有，所以下面这条到现在依然成立。
check(
  '拼写词典里没有中文（内核的清单里也没有：列上去等于一个永远不生效的选项）',
  !SPELLCHECK_LANGUAGES.some((entry) => entry.code.startsWith('zh')),
)
check(
  '只把内核实有的那一门交给它，被丢掉的那一门留在返回值里（供调用点记日志）',
  (() => {
    const resolved = resolveSpellcheckLanguages('de,en-US', 'de', ['en-US'])
    return resolved.applied.length === 0 && resolved.rejected.join(',') === 'de'
  })(),
)
check(
  '空列表被收敛成默认："一门都不查"与"功能坏了"在用户看来没有区别',
  normalizeSpellcheckLanguages('') === DEFAULT_SPELLCHECK_LANGUAGES &&
    normalizeSpellcheckLanguages('de-DE') === DEFAULT_SPELLCHECK_LANGUAGES,
)

/**
 * **一次只交给内核一门**（[ADR-0089]）—— 这是这一块最关键的一格。
 *
 * 它两边的错法都完全静默，而且**正是上一次实测到的那个现象**：交多门时内核把几门的词表合成一组
 * （并集，[ADR-0075] 实测），纠错建议也来自那一组 —— 于是"界面是西语、却给我英语建议"无法避免。
 * 交少了（一门都不交）是"拼写检查看起来没做"。
 */
check(
  '一次只交一门：界面语言匹配到的那一门（哪怕它排在后面），且只有它',
  (() => {
    const resolved = resolveSpellcheckLanguages('en-US,es,de', 'es_LA', ['en-US', 'es', 'de'])

    return (
      resolved.applied.join(',') === 'es' &&
      resolved.rejected.length === 0 &&
      pickSpellcheckLanguage('en-US,es,de', 'es_LA') === 'es'
    )
  })(),
  '交了不止一门（回到并集语义：建议会掺进别的语言），或者挑中的不是界面语言那一门',
)
check(
  '匹配不上时按**清单的次序**回落第一门（次序因此是回落顺序，不只是好看）',
  pickSpellcheckLanguage('es,en-US', 'zh_CN') === 'es' &&
    pickSpellcheckLanguage('es,en-US', null) === 'es',
  '回落点变了：界面语言是我们这 24 门之外时（中文、日语）会用错一门',
)
check(
  '挑的那一门**不在清单里**时不顺手动清单（只按次序回落）',
  pickSpellcheckLanguage('en-US,de', 'es_LA') === 'en-US' &&
    adoptInterfaceDictionary('en-US,de', 'es', false) === null,
  '挑的这一步改了设置：那会让用户的清单自己变',
)

/**
 * [ADR-0089] 撤掉了"逐门停用"那个开关，而既有的 `settings.json` 里可能还留着那个记号
 * （`language` 码前的 `-`）。它必须被**读成那一门还在**，而不是被当成表外的值剔掉 ——
 * 后者在用户看来是"升级之后我少了一门"。
 */
check(
  '旧值里那个"停用"记号被抹掉、那一门保住（升级路径）',
  parseDictionaryList('en-US,-de').join(',') === 'en-US,de' &&
    normalizeSpellcheckLanguages('-de,en-US') === 'de,en-US',
  '升级之后用既有的 `settings.json` 会静默少一门 —— 那是最难被发现的那种数据丢失',
)

const spellcheckSection = sectionOfRow('spellcheckLanguages')
check(
  '词典与拼写检查开关在同一个区域，且紧跟其后（清单离开开关就读不懂它是给谁查的）',
  spellcheckSection !== null &&
    spellcheckSection === sectionOfRow('spellcheck') &&
    spellcheckSection.rows.indexOf('spellcheckLanguages') ===
      spellcheckSection.rows.indexOf('spellcheck') + 1,
)

// `windowSource` 复用它上面那一节（"关闭窗口 = 隐藏"）读到的同一份文本。
// UA 归会话级（`applyUserAgent()` 在 `session.ts` 里）—— `src/main/language.ts` 随 [ADR-0066] 删除。
const sessionSource = source('../src/main/session.ts')

check(
  '承载上游页面的窗口不自己设 UA（两处各设一半会让会话那一份被静默盖掉）',
  !windowSource.includes('webContents.setUserAgent(') &&
    sessionSource.includes('ses.setUserAgent('),
  windowSource.includes('webContents.setUserAgent(')
    ? 'window.ts 里又出现了这一次调用'
    : 'session.ts 里找不到会话级的 setUserAgent',
)

/**
 * 「拼写检查」那一项的全部依赖就是承载页面的那扇窗口的一个 `webPreferences` 布尔值
 * （内核默认 `true`）。它坏起来完全静默：没有日志、设置页显示"已开启"，而输入框里一条红线都
 * 没有 —— 与"词典没下载下来"在用户看来一模一样。因此断言**那个函数体里**写着它，而不是全文件
 * 搜一次（两扇本地窗口也有 `webPreferences`，搜全文会在主窗口那一处被删掉之后依然变绿）。
 */
const mainWindowBody = /export function createMainWindow[\s\S]*?\n}/.exec(windowSource)?.[0] ?? ''
check(
  '承载上游页面的窗口显式声明 spellcheck: true（否则"某处顺手设成 false"是静默的）',
  /spellcheck:\s*true/.test(mainWindowBody),
  mainWindowBody === ''
    ? 'window.ts 里找不到 createMainWindow()'
    : 'createMainWindow() 的 webPreferences 里没有 spellcheck: true',
)

/**
 * 词典下载源（[ADR-0068]）。它坏起来**完全静默**：删掉那一行（或改回内核默认的 Google CDN）
 * 之后，在目标网络里下载会**停在半路** —— 既不成功也不失败，日志与界面都没有一点异常。因此把
 * "换过源、换的是哪一个（含结尾那个 `/`，内核会把文件名直接拼在它后面）"钉住。
 */
const spellcheckSource = source('../src/main/spellcheck.ts')
check(
  '词典下载源被显式换成 Edge 那个源，而不是内核默认的 Google CDN（[ADR-0068]）',
  spellcheckSource.includes(
    "DICTIONARY_DOWNLOAD_URL = 'https://edge.microsoft.com/redirectordictionaries/dict/'",
  ) && spellcheckSource.includes('setSpellCheckerDictionaryDownloadURL('),
  'spellcheck.ts 里找不到换源的那一行：默认源在目标网络里会静默挂死',
)
check(
  '换源早于**每一个**分支：`setSpellCheckerLanguages()` 之前，也在"内核还没给出清单"那次早退之前',
  spellcheckSource.indexOf('setSpellCheckerDictionaryDownloadURL(') <
    spellcheckSource.lastIndexOf('setSpellCheckerLanguages(') &&
    spellcheckSource.indexOf('setSpellCheckerDictionaryDownloadURL(') <
      spellcheckSource.indexOf('available.length === 0'),
  '顺序反了：有一批下载仍然会走默认源（内核默认值那一支尤其隐蔽）',
)

/**
 * **词典的默认值跟随内嵌页面的界面语言**（[ADR-0088]）。
 *
 * 这条路每一格出错都是安静的，因此把两件最容易写错的事钉住：
 *
 *   - **匹配的顺序**：先认区域、再按表里的顺序落回基础语言。反了（或写成"列表里先出现的"）
 *     的症状是"英式英语的界面配上了美式词典"这类看着像对的错；而界面语言是我们这 24 门以外的
 *     （中文、日语）必须是 `null` —— 那一路"选一门近似的"会安静地给用户配错语言；
 *   - **动手的分寸**：只有"清单还停在写死的默认值上"才换掉它，用户排过的一律不动；启动那一次
 *     **连补都不补**（磁盘上那条 cookie 是**上次**留下的值，拿它改用户排过的清单就是跟用户抢）。
 */
check(
  '界面语言 → 词典：先认区域，其次按表里的顺序落回基础语言，认不出的是 `null`',
  matchDictionaryLanguage('en_GB') === 'en-GB' &&
    matchDictionaryLanguage('EN_us') === 'en-US' &&
    matchDictionaryLanguage('es_LA') === 'es' &&
    matchDictionaryLanguage('de_DE') === 'de' &&
    matchDictionaryLanguage('pt_PT') === 'pt-BR' &&
    matchDictionaryLanguage('en_AU') === 'en-US' &&
    matchDictionaryLanguage('zh_CN') === null &&
    matchDictionaryLanguage('ja') === null &&
    matchDictionaryLanguage('  ') === null,
  '匹配的顺序或回落点变了：区域对不上时会安静地配上一门别的语言',
)
check(
  '只有"清单还停在写死的默认值上"才换掉它；用户排过的不动，启动那一次连补都不补',
  adoptInterfaceDictionary(DEFAULT_SPELLCHECK_LANGUAGES, 'es', false) === 'es' &&
    adoptInterfaceDictionary(DEFAULT_SPELLCHECK_LANGUAGES, 'en-US', false) === null &&
    adoptInterfaceDictionary('en-US,de', 'es', false) === null &&
    adoptInterfaceDictionary('en-US,de', 'es', true) === 'es,en-US,de' &&
    adoptInterfaceDictionary('de,es', 'es', true) === null &&
    adoptInterfaceDictionary('en-US,de', null, true) === null,
  '要么把用户排过的清单覆盖了，要么把"界面语言变了"该补的那一门丢了',
)

const pageLanguageSource = source('../src/main/page-language.ts')
check(
  '跟随界面语言那条路只**读** cookie（[ADR-0066] 的写入例外不许从这条路上回来）',
  pageLanguageSource.includes('cookies.get(') && !pageLanguageSource.includes('cookies.set('),
  '它要么不读那条 cookie（功能等于没做），要么写了它（那是 ADR-0066 撤掉的那件事）',
)
check(
  '那条 cookie 的名字只有一个来源：两个读者都不自己写字符串',
  !pageLanguageSource.includes("'wa_web_lang_pref'") &&
    !source('../src/main/dev-probe-lang.ts').includes("'wa_web_lang_pref'"),
  '又出现了一份字面量：改名字时另一个读者会静默地什么都观察不到',
)
check(
  '跟随界面语言早于那次装配，且装配传的是刚读到的设置（拿快照去装配会让内核与设置不一致）',
  sessionSource.includes('await followPageLanguage(ses, getSettings)') &&
    sessionSource.indexOf('await followPageLanguage(ses, getSettings)') <
      sessionSource.indexOf('applySpellcheck(ses, getSettings())') &&
    sessionSource.indexOf('applySpellcheck(ses, getSettings())') <
      sessionSource.indexOf('watchPageLanguage(ses, getSettings)') &&
    !sessionSource.includes('applySpellcheck(ses, settings)'),
  '顺序反了，或者又把动身前那份快照传给了 applySpellcheck()',
)

/**
 * 「立即重启」这条链（[ADR-0064]）与「界面语言已撤」的回归守卫（[ADR-0066]）。
 *
 * 它们有同一类**静默**的坏法，都靠下面的断言挡住：
 *
 *   - **顺序**：`relaunch()` 必须在 `quit()` **之前**；反了就是"点了重启、应用没了"。
 *     同理必须是 `quit()` 而不是 `exit()` —— `exit()` 不发 `before-quit` / `will-quit`，
 *     于是"退出时清除归档"（隐私承诺）与 SQLite 收尾一起被跳过，而日志里什么都看不出来。
 *   - **四处一致**："新增一个能力 = 新增一个具名方法 + 一条通道"（`shared/bridge.ts` 开头），
 *     桥、preload、通道表与处理器四处漏掉任何一处，症状都是"点了没反应"。
 *   - **撤掉的东西不许悄悄回来**：[ADR-0066] 撤掉「界面语言」时连带退休了 INV-1 的**写入例外**
 *     （那是这个项目唯一一处往页面存储里写东西的口子）。下面那条负向断言就是这件事在 CI 里的
 *     化身 —— `eslint.config.mjs` 那几条禁的是**注入**类 API，管不到"写 cookie"。
 */
const bridgeSource = source('../src/shared/bridge.ts')
const preloadSource = source('../src/preload/index.ts')
const channelsSource = source('../src/main/ipc/channels.ts')
const ipcSource = source('../src/main/ipc/index.ts')
const settingsViewSource = source('../src/renderer/views/settings.ts')

const cookieWriters = srcFiles.filter((file) => {
  const code = stripComments(readFileSync(file, 'utf8'))
  return code.includes('.cookies.set(') || code.includes('.cookies.remove(')
})

check(
  'INV-1 不再有写入例外：`src/` 里没有任何地方写 cookie（[ADR-0066] 把它撤掉了）',
  cookieWriters.length === 0,
  `这几处在写 cookie：${cookieWriters.map((file) => basename(file)).join(', ')}`,
)
check(
  '「界面语言」那一行是**说明**而不是设置项，且说清了入口在手机端（[ADR-0066]）',
  settingsViewSource.includes('手机版 WhatsApp') &&
    !settingsViewSource.includes('UI_LANGUAGES') &&
    !settingsViewSource.includes('uiLanguage'),
  '设置页里那句话不在，或者语言选择器又回来了 —— 后者是一个改不动页面的开关',
)

/**
 * 词典那一块的**形态**（[ADR-0070] / [ADR-0069]）：行上是"表头（「添加语言」+ 说明）+ 一张
 * 一门一行、每行一颗 `⋯` 的清单"，点开是一张带搜索的模态清单；每行还有一颗拖动把手（[ADR-0087]）
 * 与一个"这一门参不参与检查"的开关。
 *
 * 它坏起来是静默的 —— 类名改了却忘了改样式表，控件照样能勾、能存，只是**看不出是个控件**
 * （没有边框，对话框既没有遮罩也没有尺寸，把手只剩一个看不出能拖的符号）。因此把两边一起断言。
 */
const LANGUAGE_UI_CLASSES = [
  'language-field',
  'language-head',
  'language-items',
  'language-item',
  'language-handle',
  'language-name',
  'language-code',
  'language-progress',
  'language-status',
  'language-retry',
  'language-menu-button',
  'language-menu',
  'language-menu-item',
  'language-menu-separator',
  'language-dialog',
  'language-search',
  'language-list',
  'language-option',
]
check(
  '拼写词典是"表头 + 一门一行的清单（拖动把手 + 下载进度 + `⋯`）+ 一张可搜索的模态清单"，且每一处的样式都真的有定义（[ADR-0070] / [ADR-0071] / [ADR-0087] / [ADR-0089]）',
  LANGUAGE_UI_CLASSES.every(
    (name) => settingsViewSource.includes(`'${name}'`) && stylesheet.includes(`.${name} {`),
  ),
  '类名与样式表对不上：控件会静默失去外观（或者那一整块根本没画出来）',
)

/**
 * 拖动排序的两个记号（[ADR-0087]）：拖动中的那一行、以及落点那条线。
 *
 * 又一处**静默**的坏法：属性名改了却忘了改样式表，行照样能拖、松手照样会重排，只是全程没有
 * 任何东西告诉用户"松手会落在哪里" —— 而"看不见落点"正是这个手势最没法用的时候。因此把视图里
 * 写属性的那一句与样式表里的选择器一起钉住。
 */
check(
  '拖动排序的两个记号（拖动中的行 / 落点线）在视图与样式表两边对得上（[ADR-0087]）',
  settingsViewSource.includes("row.dataset['dragging'] = 'true'") &&
    settingsViewSource.includes("row.dataset['drop'] = after ? 'after' : 'before'") &&
    stylesheet.includes(".language-item[data-dragging='true']") &&
    stylesheet.includes(".language-item[data-drop='before']") &&
    stylesheet.includes(".language-item[data-drop='after']"),
  '拖动的落点线画不出来：用户拖了一路却不知道松手会落在哪一行',
)

/**
 * 「下载中」那一段的**几何**（[ADR-0071]；斜纹换成扫动条见 [ADR-0074]）。
 *
 * 判据分散成两处：`width` 在那条状态规则里，两个 `translateX` 在 `@keyframes` 里，而它们必须
 * 彼此对得上 —— 起点要在**左外侧**（否则那一段会在轨道中间**凭空冒出来**）、终点要把**整段**
 * 送出**右外侧**（否则它会在还看得见的时候**跳回左边**）。
 *
 * 只改一处不会报错，只会"看着有点怪"，而那一下恰好很难被眼睛抓住（只觉得"有点抖"）——
 * 因此这里钉住它。刻意不检查颜色、时长与计时函数（那些是取舍，写在 ADR 里）。
 */
const sweepBand = /\[data-state='downloading'\]::after \{[\s\S]*?width: (\d+)%/.exec(stylesheet)
const sweepFrames = /@keyframes dictionary-downloading \{([\s\S]*?)\n\}/.exec(stylesheet)
const sweepShifts =
  sweepFrames === null
    ? []
    : [...sweepFrames[1].matchAll(/translateX\((-?\d+)%\)/g)].map((shift) => Number(shift[1]))
check(
  '「下载中」那一段从轨道左外侧起步、整段走出右外侧，且终点与它自己的宽度对得上（对不上 = 凭空冒出或跳回）',
  sweepBand !== null &&
    sweepShifts.length === 2 &&
    sweepShifts[0] <= -100 &&
    sweepShifts[1] * Number(sweepBand[1]) === 100 * 100,
  sweepBand === null || sweepFrames === null
    ? '样式表里找不到「下载中」那一段的 width 或者 @keyframes dictionary-downloading'
    : `width 是 ${sweepBand === null ? '（没找到）' : sweepBand[1]}%，两个 translateX 是 ${sweepShifts.join(' / ')}`,
)

/**
 * 关掉动效时，两态**仍然**分得开（[ADR-0074]）。
 *
 * [ADR-0074] 之后 `ready` 与 `downloading` 是**同一种蓝**，全靠"动没动"分开 —— 而这条媒体
 * 查询正是把"动"关掉的那一处。若它把 `downloading` 退回"走满的纯蓝"，两态就**完全同形**，
 * 且界面上没有任何别的东西能提示差别。分开它们的是浓淡（`opacity`），因此这里必须看到它。
 */
const reducedMotion = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(stylesheet)
check(
  '关掉动效时「下载中」仍然与「已就绪」分得开（两者都是蓝，这条规则是唯一的区分手段：[ADR-0074]）',
  reducedMotion !== null &&
    /data-state='downloading'\]::after \{[\s\S]*?opacity:/.test(reducedMotion[1]),
  '这里退回"走满的纯蓝"就等于把「下载中」画成了「已就绪」—— 两态从此同形',
)

/**
 * 「待选」与「等待中」两格**不许**退回"一条灰槽"（[ADR-0091]）。
 *
 * 这两个状态此前共用一条浅灰轨道（`unknown` 没有填充），而设置页上多数行在多数时候都是
 * `unknown` 那一态 —— 用户看到的因此是"一堆灰色/没有颜色的进度条"，读作"坏了"。修法是给
 * 它们各自一个**形状**与一句**文字**：
 *
 *   - `unknown` → 虚线空槽（`border: 1px dashed`），形状上就是"空位"；
 *   - `pending` → 走满的淡蓝（`opacity`），与"已就绪"靠浓淡分开（同 [ADR-0074] 那套判据）。
 *
 * 只改一边不会报错，只会让那一格重新变成一条说不清状态的灰条 —— 因此两边一起钉。
 */
check(
  '「候选」有虚线空槽、「等待中」有走满的淡蓝（否则又回到"一条灰槽"：[ADR-0091]）',
  /\[data-state='unknown'\] \{[\s\S]*?border: 1px dashed var\(--muted\)/.test(stylesheet) &&
    /\[data-state='pending'\]::after \{[\s\S]*?opacity:/.test(stylesheet),
  '这两态又变成"灰槽"了：用户会把它们读成坏掉的进度条',
)

/**
 * 每一态**都有一句话**，不只靠颜色（[ADR-0091]）。
 *
 * 颜色答不了"这一格到底在干什么"：`unknown` 根本没有颜色可看，而 `pending` / `ready` 只差
 * 一档浓淡（关掉动效时 `downloading` 也挤在这条色阶上）。四个字样缺一个，那一态就退回
 * "要靠猜"—— 而猜错的代价是"以为词典在下载"或"以为词典坏了"。
 */
check(
  '词典的五个状态都有看得懂的文字（「待选」「等待中…」「下载中…」「下载失败」），不只靠颜色',
  ['待选', '等待中…', '下载中…', '下载失败'].every((text) =>
    settingsViewSource.includes(`'${text}'`),
  ),
  '有一态只剩颜色在说话：用户分不出"在等"「在下」「下不来」',
)

/**
 * 词典下载状态这一条链（[ADR-0071]）与它最容易静默坏掉的那一处。
 *
 * "语言码大小写归一"是这条链上唯一的**推理**（不是实测）：事件里的码用的是我们交给内核的
 * 那个形状，而设置里存的是另一份字符串。两处都调 `dictionaryKey()` 才保证它们碰得上 ——
 * 少一处，那一格永远停在"未开始"，而那与"这门词典本来就不需要下载"长得一模一样。
 */
check(
  '词典下载状态四处齐全：桥 / preload / 通道表 / 处理器，且状态由主进程推给设置窗口',
  bridgeSource.includes('getDictionaryStatuses(): Promise<DictionaryStatusMap>') &&
    bridgeSource.includes('onDictionaryStatusChange(listener:') &&
    preloadSource.includes('CHANNELS.dictionaryStatus)') &&
    preloadSource.includes('CHANNELS.dictionaryStatusChanged') &&
    channelsSource.includes("dictionaryStatus: 'settings:dictionary-status'") &&
    channelsSource.includes("dictionaryStatusChanged: 'settings:dictionary-status-changed'") &&
    ipcSource.includes('CHANNELS.dictionaryStatus,') &&
    ipcSource.includes('dictionaryStatusSnapshot') &&
    sessionSource.includes('onDictionaryStatusChange('),
  '有一处漏了：那一门词典的状态会静静地什么都不显示（没有反应也没有报错）',
)
check(
  '状态表的键在两处都经过 `dictionaryKey()` 归一（少一处 = 那一格永远停在"未开始"）',
  spellcheckSource.includes('dictionaryKey(') && settingsViewSource.includes('dictionaryKey('),
  '大小写没有归一：内核事件里的码与设置里存的码将彼此看不见',
)

/**
 * 「重试」这条链（[ADR-0091]）。四处缺一，那颗按钮就是**假的** —— 点下去什么都不发生，
 * 而界面上没有任何东西说它坏了（按钮照旧能按、照旧不变灰）。
 *
 * 它同时是"词典下载失败之后唯一的出路"：内核把失败当终局（[ADR-0072]），应用自己退避重试
 * 两次之后就再没有别的路，重启应用是第二种。因此这条链比一般的一颗按钮更值得钉住。
 */
check(
  '「重试」四处齐全：桥 / preload / 通道表 / 处理器，且界面真的画了那颗按钮（[ADR-0091]）',
  bridgeSource.includes('retryDictionaries(): Promise<void>') &&
    preloadSource.includes('CHANNELS.dictionaryRetry') &&
    channelsSource.includes("dictionaryRetry: 'settings:dictionary-retry'") &&
    ipcSource.includes('CHANNELS.dictionaryRetry,') &&
    ipcSource.includes('retryDictionaryDownload(') &&
    settingsViewSource.includes('bridge().retryDictionaries()') &&
    settingsViewSource.includes("class: 'language-retry'"),
  '有一处漏了：那颗「重试」按下去什么都不会发生，而它不会报错',
)

/**
 * 主进程入口。这一节要读它两处：词典源写得够不够早（[ADR-0072]），以及下面那节"实例隔离"里的
 * 启动顺序（[ADR-0062]）。
 */
const entrySource = source('../src/main/index.ts')

/**
 * 词典下载源必须写在**任何会话被创建之前**（[ADR-0072]）。
 *
 * 这是一条实测出来的时序：已启用的语言持久化在 profile 的 `Preferences` 里，
 * 而内核在**会话被创建**的那一刻就用那个列表开始取词典。晚一步写源，第一次请求就落到内核默认的
 * Google CDN（在本网络里挂死），而之后再设一遍同一个语言列表**什么都不做**（实测）—— 于是那一门
 * **永远**下不下来。顺序错了不会报错，只会让一门词典一直在"下载中"然后失败。
 */
const atDictionarySource = entrySource.indexOf('applyDictionaryDownloadSource(')
const atFirstSession = entrySource.indexOf('session.fromPartition(')
check(
  '词典下载源写在**任何**会话被创建之前（写晚了 = 持久化的那几门永远下不下来）',
  atDictionarySource > -1 && atFirstSession > -1 && atDictionarySource < atFirstSession,
  atDictionarySource === -1
    ? 'src/main/index.ts 里找不到 applyDictionaryDownloadSource('
    : `第一处会话创建在第 ${atFirstSession} 个字符处，写源却在第 ${atDictionarySource} 个`,
)
check(
  '词典下载失败会安排一次重试（内核自己不会再来一次：[ADR-0072]）',
  spellcheckSource.includes('scheduleDictionaryRetry(ses, getSettings, languageCode)') &&
    spellcheckSource.includes('dictionaryRetryDelay(') &&
    spellcheckSource.includes('retryDictionaryDownload('),
  '失败只剩一条通知了：一次抖动就等于那一门永远缺着',
)

/**
 * 词典事件的订阅必须**紧跟建会话**（[ADR-0073]）。
 *
 * 又一条实测出来的时序，而且还是上一节那条（[ADR-0072] "源要写在建会话之前"）的同一根因的另一半：
 * 内核在建会话那一刻就开始按 profile 里持久化的语言列表装载词典，**4ms** 后就把
 * `spellcheck-dictionary-initialized` 发了出去（两趟本机探针），而那四个事件**不会重发**
 * —— 把同一个语言列表再设一遍是 no-op（[ADR-0072]，同一批探针也量过）。
 *
 * 订阅原来排在 `configureSession()` 里，前面隔着一次读 cookie 的往返（实测约 8ms）。晚这几毫秒
 * 不会报错：那几格永远停在**空槽**，而"空槽"与"这门词典本来就不需要下载"在界面上长得一模一样 ——
 * 用户读到的就是"词典一直没下载"。判据因此是三个调用点的**前后位置**。
 *
 * 指针都带上调用形状（`attachDictionaryWatch(ses` 而不是 `attachDictionaryWatch`），并且先剥掉
 * 注释：这几段注释里正写着这些名字，只按名字找会指到注释上，于是代码顺序真被改反时它也不变红。
 */
const entryCode = entrySource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
const atWatchSession = entryCode.indexOf('session.fromPartition(sessionPartition())')
const atDictionaryWatch = entryCode.indexOf('attachDictionaryWatch(ses')
const atAccountKey = entryCode.indexOf('await resolveAccountKey(')
check(
  '词典事件订阅紧跟建会话、早于第一处 await（晚了 = 磁盘上已有的那几门永远停在空槽）',
  atWatchSession > -1 && atDictionaryWatch > atWatchSession && atAccountKey > atDictionaryWatch,
  atDictionaryWatch === -1
    ? 'src/main/index.ts 的代码里找不到 attachDictionaryWatch(ses'
    : `建会话在第 ${atWatchSession} 个字符处，订阅在第 ${atDictionaryWatch} 个，` +
        `而第一处 await 在第 ${atAccountKey} 个（订阅必须夹在中间）`,
)

/**
 * 「至少要留一门」在**清单那一侧**的闸门（[ADR-0070]）：只剩一门时 `⋯` 里的「移除」是禁用的。
 *
 * 它与对话框里那条（草稿为空时禁用「确定」）是必须同时在位的落点 —— 少一个，用户就能把清单删空，
 * 而那个值会被 `normalizeSpellcheckLanguages()` 收敛回**默认值**：看起来像"它自己变回去了"。
 * [ADR-0089] 之前这里还有第二个闸门（"只剩一门参与检查时禁用那一门的开关"），那个开关已经撤掉了
 * —— 一门参不参与检查不再由用户逐门决定，因此那一格没有对象了。
 *
 * 这里只能做文本扫描，因此它挡的是**被人顺手删掉**，不是"逻辑写错了"。
 */
check(
  '「至少要留一门」的闸门还在位：只剩一门时「移除」禁用（[ADR-0070]）',
  settingsViewSource.includes('const removable = codes.length > 1') &&
    settingsViewSource.includes('disabled: !options.removable'),
  '闸门不见了：删到一门不剩时，设置会被悄悄收敛回默认值',
)

/**
 * **逐门开关已经撤掉**（[ADR-0089]）：那一格的对象（"这一门参不参与检查"）没有了 —— 每一时刻
 * 真正用来查的只有一门，由界面语言从这张候选清单里挑。
 *
 * ⚠️ 它回来的话会有两个后果：① 界面上又出现一个"按了也不影响任何事"的控件（那正是 [ADR-0070]
 * 当年要防的）；② 而且这次更糟 —— 交多门会回到 [ADR-0075] 的并集语义，"界面是西语却给英语建议"
 * 那个实测现象会原样回来。
 */
check(
  '清单行上没有逐门的启用开关了（那一格的对象随 [ADR-0089] 一起撤掉）',
  !settingsViewSource.includes('language-toggle') &&
    !settingsViewSource.includes('setDictionaryEnabled') &&
    !stylesheet.includes('language-toggle'),
  '那个开关又回来了：而交多门正是"界面是西语却给英语建议"的根因',
)
const restartSource = source('../src/main/restart.ts')

/**
 * 去掉注释之后的源码。
 *
 * 下面两条断言问的是"**代码里**有没有这么写"，而这个文件的注释里**必须**写着
 * `app.exit()` 与 `app.quit()` —— 那是给下一个改它的人看的理由。裸文本扫描会把说明当成
 * 违规（本自检第一次跑就是这么红的），于是这类断言要么去掉注释再找，要么就只能改成
 * 一句谁都不敢解释的话。
 */
const restartCode = restartSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
const atRelaunch = restartCode.indexOf('app.relaunch(')
const atQuit = restartCode.indexOf('app.quit(')

check(
  '「立即重启」先 relaunch 再 quit（顺序反了 = 点了重启、应用没了）',
  atRelaunch > -1 && atQuit > atRelaunch,
  atRelaunch === -1
    ? 'restart.ts 的代码里找不到 app.relaunch()'
    : `app.quit() 出现在 app.relaunch() 之前（${atQuit} < ${atRelaunch}）`,
)
check(
  '「立即重启」走 app.quit()（app.exit() 会跳过退出清理：清除归档与关库）',
  !restartCode.includes('app.exit('),
  'restart.ts 的代码里用了 app.exit()：before-quit / will-quit 不会发出',
)

check(
  '「立即重启 / 待办状态」两条能力四处齐全：桥 / preload / 通道表 / 处理器',
  bridgeSource.includes('getRestartState(): Promise<RestartState>') &&
    bridgeSource.includes('restart(): Promise<void>') &&
    preloadSource.includes('CHANNELS.restartState') &&
    preloadSource.includes('CHANNELS.restart)') &&
    channelsSource.includes("restartState: 'app:restart-state'") &&
    channelsSource.includes("restart: 'app:restart'") &&
    ipcSource.includes('CHANNELS.restartState') &&
    ipcSource.includes('CHANNELS.restart,'),
  '有一处漏了：调用会静默失败（没有反应也没有报错）',
)
check(
  '那颗「立即重启」的显示判据来自主进程的待办状态，而不是写死成常驻按钮',
  settingsViewSource.includes('restartState.restart.length === 0') &&
    settingsViewSource.includes('pendingRestartRow'),
  'views/settings.ts 里找不到基于 restartState 的判据',
)

/**
 * 右键菜单里**每一个** `role` 项都必须带 `label`。
 *
 * `role` 的默认文案取自 Chromium 自己的 locale（`--lang` 曾经能把它切走，[ADR-0063]；那一项已由
 * [ADR-0066] 撤掉，但**系统 locale 照样可能是英文**）—— 那时用户会在**我们自己的**菜单里看到
 * Cut / Copy / Paste / Select All。而我们的界面文案必须是中文（`ai/CONVENTIONS.md` 第 1 节）。
 *
 * 断言"每一个 role 都有 label"而不是逐项点名：将来加一项（`redo` / `undo`）时，这里会直接变红。
 */
const menuSource = source('../src/main/context-menu.ts')
const roleItems = menuSource.match(/\{\s*role:\s*'[a-zA-Z]+'[^}]*\}/g) ?? []
check(
  '右键菜单里每个 role 项都带中文 label（否则会跟着内嵌页面的语言变成英文）',
  roleItems.length > 0 && roleItems.every((item) => item.includes('label:')),
  roleItems.length === 0
    ? 'context-menu.ts 里找不到任何 role 项'
    : `这几项没有 label：${roleItems.filter((item) => !item.includes('label:')).join(' ')}`,
)

/**
 * 主题（[ADR-0078]：浅色 / 深色 / 跟随系统）。
 *
 * 这一项有三种**静默**的坏法，都值得钉住：
 *
 *   - **窗口底色与样式表的两组 `--bg` 不一致**：底色只在"窗口已经出现、内容还没画出来"之间
 *     可见，对不上就是一次白闪 —— 而深色桌面上的那次白闪正是这一项要解决的问题本身。
 *   - **晚于建窗口**：`backgroundColor` 在窗口构造时就取了值，"跟随系统"时那是系统**当时**的
 *     深浅 —— 晚一步，启动瞬间用的就是上一次的答案。
 *   - **认不出的取值一路走到 `nativeTheme`**：任何字符串都能骗过 `typeof value === 'string'`
 *     那圈校验，因此收敛必须发生在**读设置**的那一刻（与拼写检查清单同一条纪律）。
 */

section('主题')

const themeSource = source('../src/shared/theme.ts')
const themeMainSource = source('../src/main/theme.ts')
const mainSettingsSource = source('../src/main/settings.ts')
check(
  '窗口底色与样式表的两组 `--bg` 逐字符一致（对不上＝深色桌面上每次启动闪一下白）',
  stylesheet.includes(`--bg: ${WINDOW_BACKGROUND.light};`) &&
    stylesheet.includes(`--bg: ${WINDOW_BACKGROUND.dark};`),
  'styles.css 里的 --bg 与 shared/theme.ts 的 WINDOW_BACKGROUND 对不上',
)
check(
  '主题在**任何窗口被创建之前**应用，且底色跟着系统主题刷新',
  entrySource.includes('applyTheme(settings.theme)') &&
    entrySource.indexOf('applyTheme(settings.theme)') <
      entrySource.indexOf('= createMainWindow(') &&
    themeMainSource.includes("nativeTheme.on('updated'"),
  '主题要么排在建窗口之后（启动瞬间的底色是上一次的答案），要么没有订阅系统主题的变化',
)
check(
  '主窗口与本地窗口都按当前主题设了底色（只设一处＝切主题时看得见一块没跟上）',
  // 两处构造：`createMainWindow()` 与 `createLocalWindow()`（后者被文件列表与设置共用）。
  (windowSource.match(/backgroundColor: currentWindowBackground\(\)/g) ?? []).length >= 2,
  'window.ts 里有窗口没设 backgroundColor —— 深色下它会先闪一下白',
)
check(
  '主题取值在读设置的那一刻收敛（认不出的值不许一路走到 nativeTheme）',
  mainSettingsSource.includes('normalizeTheme('),
  'main/settings.ts 里没有收敛主题的调用',
)
check(
  '改设置时主题立刻生效，且不在"重启后生效"名单里',
  ipcSource.includes("if ('theme' in patch) applyTheme(next.theme)") &&
    !RESTART_REQUIRED_SETTINGS.includes('theme'),
  '主题要么没在改设置时应用，要么被误加进了需要重启的清单',
)
check(
  '主题的三个取值与 nativeTheme 的三个取值同形（它只认 system / light / dark）',
  THEME_OPTIONS.map((option) => option.value)
    .sort()
    .join(',') === 'dark,light,system' &&
    DEFAULT_THEME === 'system' &&
    normalizeTheme('dark') === 'dark' &&
    normalizeTheme('没有这个主题') === DEFAULT_THEME,
  '取值表被改过 —— 认不出的值会被 nativeTheme 静默忽略，界面看起来只是"没反应"',
)
check(
  '主题在「外观与启动」区域，且选项由视图照着共享清单渲染（少一个＝那个取值在界面上无法抵达）',
  sectionOfRow('theme')?.title === '外观与启动' &&
    new Set(THEME_OPTIONS.map((option) => option.value)).size === THEME_OPTIONS.length &&
    settingsViewSource.includes('THEME_OPTIONS') &&
    themeSource.includes('WINDOW_BACKGROUND'),
  '主题那一行不在「外观与启动」，或者视图没有照着共享的选项清单渲染',
)

/**
 * 界面缩放（[ADR-0079]：菜单里的放大 / 缩小 / 实际大小 + 设置页那一行）。
 *
 * 它比主题多一条**结构性**的风险：缩放有两个入口（设置页走 `settings:set`，菜单走
 * `main/zoom.ts`），而两条路都要把"三扇窗口跟上"与"设置页那一行不是陈旧的"做完。少任何一半的
 * 症状都是安静的：菜单按了没反应、或者设置页显示着 100% 而界面明明已经放大。
 */

section('缩放')

const zoomSource = source('../src/shared/zoom.ts')
const zoomMainSource = source('../src/main/zoom.ts')
const appMenuTemplateSource = source('../src/main/menu.ts')
check(
  '归一化：认不出的值与超范围的值都收敛到合法档位（内核会把超范围的值静默夹到它自己的边界）',
  normalizeZoomFactor('1.5') === DEFAULT_ZOOM_FACTOR &&
    normalizeZoomFactor(Number.NaN) === DEFAULT_ZOOM_FACTOR &&
    normalizeZoomFactor(99) === MAX_ZOOM_FACTOR &&
    normalizeZoomFactor(0) === MIN_ZOOM_FACTOR &&
    normalizeZoomFactor(1.3) === 1.25,
  '有一个坏值会在界面与内核之间产生分歧（界面显示一个数、内核执行另一个数）',
)
check(
  '设置页的档位由菜单用的那张表派生（两张表不一致的症状是"菜单走到某档、下拉框里没有它"）',
  ZOOM_OPTIONS.length === ZOOM_STEPS.length &&
    ZOOM_OPTIONS.every((option, index) => option.value === ZOOM_STEPS[index]) &&
    zoomSource.includes('ZOOM_STEPS.map(') &&
    settingsViewSource.includes('ZOOM_OPTIONS'),
  '设置页的选项与菜单的档位不是同一张表',
)
check(
  '走一档不会原地踏步，到顶 / 到底就停在原位（调用方因此能靠"没变"判断该不该落盘）',
  zoomStepUp(1) === 1.1 &&
    zoomStepDown(1) === 0.9 &&
    zoomStepUp(MAX_ZOOM_FACTOR) === MAX_ZOOM_FACTOR &&
    zoomStepDown(MIN_ZOOM_FACTOR) === MIN_ZOOM_FACTOR,
  '档位推进的判据不对 —— 菜单会点一下没反应，或者写出一个表里没有的值',
)
check(
  '应用菜单里有三个缩放项，快捷键与自带默认菜单逐字相同（这套组合在浏览器里就是这个意思）',
  appMenuTemplateSource.includes("accelerator: 'CmdOrCtrl+Plus'") &&
    appMenuTemplateSource.includes("accelerator: 'CmdOrCtrl+-'") &&
    appMenuTemplateSource.includes("accelerator: 'CmdOrCtrl+0'") &&
    appMenuTemplateSource.includes('stepZoom(1)') &&
    appMenuTemplateSource.includes('stepZoom(-1)') &&
    appMenuTemplateSource.includes('resetZoom()'),
  '缩放三项从菜单里消失了 —— 而菜单是"字太小"的人第一件会去按的东西',
)
check(
  '两扇窗口构造都按设置设缩放，并在每次加载之后再设一次（缩放级别在内核里是按 host 记的）',
  (windowSource.match(/followZoomSetting\(window\)/g) ?? []).length >= 2 &&
    windowSource.includes("on('did-finish-load'") &&
    windowSource.includes('export function applyZoomToAllWindows'),
  '有窗口没跟上缩放，或者只在建窗口时设过一次（页面一导航就回到 100%）',
)
check(
  '两个入口都让三扇窗口跟上，且都不在"重启后生效"名单里',
  ipcSource.includes("if ('zoomFactor' in patch) applyZoomToAllWindows()") &&
    zoomMainSource.includes('applyZoomToAllWindows()') &&
    !RESTART_REQUIRED_SETTINGS.includes('zoomFactor'),
  '有一个入口只改了设置值而没有落到窗口上 —— 那正是"改了没反应"',
)
check(
  '不经过界面的设置改动都会推给设置窗口（否则那一行显示的是陈旧的值）—— 推送三处齐全',
  channelsSource.includes("settingsChanged: 'settings:changed'") &&
    bridgeSource.includes('onSettingsChanged(') &&
    preloadSource.includes('CHANNELS.settingsChanged') &&
    // 主进程自己改设置的两个入口（菜单里的缩放 [ADR-0079]、词典跟随界面语言 [ADR-0088]）
    // 都走 `window.ts` 那**一处**发送方 —— 各写一份的话，其中一处很容易在某次重构里消失。
    zoomMainSource.includes('pushSettingsToSettingsWindow(') &&
    pageLanguageSource.includes('pushSettingsToSettingsWindow(') &&
    windowSource.includes('CHANNELS.settingsChanged'),
  '桥 / preload / 通道表 / 主进程发送方这一条链少了某一处（症状是设置页那一行永远停在旧值）',
)
check(
  '缩放那一行在「外观与启动」区域，且主进程在读设置的那一刻收敛它',
  sectionOfRow('zoomFactor')?.title === '外观与启动' &&
    mainSettingsSource.includes('normalizeZoomFactor('),
  '这一行不在「外观与启动」，或者读设置时没有收敛',
)

/**
 * 平滑滚动（[ADR-0081]）。
 *
 * 它坏起来是**安静**的三种形状，因此每一条都值得钉住：
 *
 *   1. **开关名与内核不再对得上** —— 命令行上多一个没人认识的开关，Chromium 静默忽略，
 *      症状是"设置里关掉了、滚动照旧带缓动"（名字是在二进制里核对过的，见 `smooth-scroll.ts`
 *      的文件头）；
 *   2. **判据用了 `getSwitchValue()` 而不是 `hasSwitch()`** —— 用户写
 *      `--disable-smooth-scrolling`（不带 `=`）时读出来是空串，于是我们**覆盖掉他显式传的**
 *      那一份，而命令行是他唯一能自己动手的地方；
 *   3. **应用时机晚于 `whenReady`** —— 命令行那时已经解析完，这一项从此永远不生效。
 */

section('平滑滚动')

const smoothScrollSource = source('../src/main/smooth-scroll.ts')

/**
 * 去掉注释之后的源码。
 *
 * 下面那条"读的是 hasSwitch 还是 getSwitchValue"问的是**代码里怎么写**，而这个文件的注释里
 * **必须**写着 `getSwitchValue()` —— 那是给下一个改它的人看的理由（"布尔开关不带 `=`，
 * 读值会把两种情况混起来"）。裸文本扫描会把说明当成违规，因此这条断言先去掉注释再找
 * （与下面 `restart.ts` 那两条同一条纪律）。
 */
const smoothScrollCode = smoothScrollSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')

/** 与 `app.commandLine` 同形的假对象（判据是纯函数，因此这里不必启动内核）。 */
function smoothScrollingCli(explicit: readonly string[] = []): {
  hasSwitch: (name: string) => boolean
  appendSwitch: (name: string) => void
} {
  const switches = new Set(explicit)

  return {
    hasSwitch: (name) => switches.has(name),
    appendSwitch: (name) => switches.add(name),
  }
}

check(
  '开关名与内核里核对过的那两个逐字一致（写错＝设置静默失效）',
  smoothScrollSource.includes("'disable-smooth-scrolling'") &&
    smoothScrollSource.includes("'enable-smooth-scrolling'"),
  '开关名被改过 —— 症状是"关掉平滑滚动却没变化"，而且不报错',
)
check(
  '判据读的是"这个开关在不在"（hasSwitch），不是它的取值 —— 布尔开关普遍不带 `=`',
  smoothScrollCode.includes('hasSwitch(') && !smoothScrollCode.includes('getSwitchValue('),
  '用了 getSwitchValue()：用户显式传的 `--disable-smooth-scrolling` 会被我们覆盖掉',
)
check(
  '关掉才写开关：开启（默认）这一侧一个字节都不动，用户显式传过就不插手',
  applySmoothScrolling(smoothScrollingCli(), true) === false &&
    applySmoothScrolling(smoothScrollingCli([NO_SMOOTH_SCROLLING_SWITCH]), false) === false &&
    applySmoothScrolling(smoothScrollingCli(['enable-smooth-scrolling']), false) === false &&
    applySmoothScrolling(smoothScrollingCli(), false) === true,
  '两条边界被改过（见 smooth-scroll.ts 的文件头）',
)
check(
  '在 whenReady 之前应用（命令行解析之后就固定了），且它在"重启后生效"名单里',
  entrySource.includes('applySmoothScrolling(app.commandLine, getSettings().smoothScrolling)') &&
    entrySource.indexOf('applySmoothScrolling(') < entrySource.indexOf('app.whenReady(') &&
    RESTART_REQUIRED_SETTINGS.includes('smoothScrolling') &&
    DEFAULT_SETTINGS.smoothScrolling === true,
  '时机或名单不对 —— 晚于 whenReady 时这一项永远不生效；不进名单则用户不知道要重启',
)
check(
  '这一行在「外观与启动」区域，且设置页里真的有它（漏了＝设置项从界面上消失）',
  sectionOfRow('smoothScrolling')?.title === '外观与启动' &&
    settingsViewSource.includes("key: 'smoothScrolling'"),
  '这一行不在「外观与启动」，或者设置页里没有它',
)

/**
 * 托盘未读徽标（[ADR-0080]）。
 *
 * 这一项有一条**结构性**的风险值得钉住：数据源只有"页面标题"一个，而它坏起来是安静的
 * ——上游改了标题格式，徽标不再出现，日志里只有在**第一次**解析时记的那一条 `count: null`。
 * 与它并排的另外两条：托盘图标现在是**合成**出来的（应用图标 + 徽标），因此任何"自己设一张
 * 裸图标"的地方都会把徽标抹掉；以及标题的归属权（我们拦下 `page-title-updated`）。
 */

section('托盘未读')

const unreadSource = source('../src/shared/unread.ts')
const unreadMainSource = source('../src/main/unread.ts')
const trayBadgeSource = source('../src/shared/tray-badge.ts')
const traySource = source('../src/main/integration/tray.ts')
check(
  '标题解析只认"（N）"前缀，读不到就是 null（而不是 0 —— 那是另一件事：读到了、确实没有未读）',
  parseUnreadCount('(3) WhatsApp') === 3 &&
    parseUnreadCount('  (12) WhatsApp') === 12 &&
    parseUnreadCount('WhatsApp') === null &&
    parseUnreadCount('(0) WhatsApp') === null &&
    parseUnreadCount('(abc) WhatsApp') === null &&
    parseUnreadCount('') === null,
  '解析判据被改过 —— 认错的表现是徽标显示一个错的数字，或者把"不知道"说成"没有未读"',
)
check(
  '徽标文字：没有未读不画，超过上限收成 99+（三位数在 22px 的图标里糊成一团）',
  unreadBadgeLabel(null) === null &&
    unreadBadgeLabel(0) === null &&
    unreadBadgeLabel(1) === '1' &&
    unreadBadgeLabel(UNREAD_BADGE_LIMIT) === String(UNREAD_BADGE_LIMIT) &&
    unreadBadgeLabel(UNREAD_BADGE_LIMIT + 1) === `${UNREAD_BADGE_LIMIT}+`,
  '徽标上限或"没有未读"的判据被改过',
)
check(
  '窗口标题由我们决定：拦下 page-title-updated（否则命名实例不再自报家门，页面标题还会盖掉未读数）',
  unreadMainSource.includes("on('page-title-updated'") &&
    unreadMainSource.includes('event.preventDefault()') &&
    unreadMainSource.includes('window.setTitle('),
  'unread.ts 里没有拦标题 —— 上游的标题会把实例名与未读数一起覆盖掉',
)
check(
  '托盘图标是"应用图标 + 徽标"合成出来的，且只有一处设它 —— 改图标不许绕过去',
  traySource.includes('trayIconWithBadge(') &&
    traySource.includes('export function syncTrayIcon') &&
    ipcSource.includes('syncTrayIcon()') &&
    !ipcSource.includes('.setImage('),
  '有一处自己设了裸图标：改一次应用图标就会把未读徽标无声地抹掉（而且不会自己回来）',
)
check(
  '未读跟踪在 createTray() 之后接上（托盘不存在时那一次调用是空转，徽标会一直空到下次变化）',
  entrySource.includes('attachUnreadTracking(mainWindow, (count) =>') &&
    entrySource.includes('applyTrayUnread(count)') &&
    entrySource.indexOf('attachUnreadTracking(') > entrySource.indexOf('createTray('),
  '顺序反了：启动后第一个未读数出现之前，托盘上不会有徽标',
)
check(
  '两个新模块都不导入 electron（判据要能在没有 Electron 的环境里断言）',
  !unreadSource.includes("from 'electron'") && !trayBadgeSource.includes("from 'electron'"),
  'shared/ 里出现了 electron 的运行时依赖',
)
check(
  '徽标几何按画布比例算、落点有边界守卫（画到画布外会串到下一行像素：一条乱码横线）',
  trayBadgeSource.includes('CENTER_RATIO') &&
    trayBadgeSource.includes('RADIUS_RATIO') &&
    trayBadgeSource.includes('x >= size || y >= size') &&
    typeof drawUnreadBadge === 'function',
  '几何被写死或边界守卫被去掉 —— 症状是图标上出现一条乱码横线，很难联想到徽标',
)

/**
 * 「减少打扰」：托盘里的静音与免打扰（[ADR-0082]）。
 *
 * 两条断言各自钉住一种**安静**的坏法：
 *
 *   1. **免打扰绕过权限层** —— 想"少弹通知"，最顺手的写法是去页面里做点什么（注入、伪造
 *      Notification、拦系统的通知守护进程）。这里断言它走的正是权限判据，而且**两个处理器
 *      （请求 / 检查）都传了同一份覆盖**：只接一边的症状是"检查通过、请求被拒"（或反过来），
 *      而那只在通话那种场合才暴露。
 *   2. **状态有第二个入口** —— 勾选态是 `Menu.buildFromTemplate` 时读一次的**快照**。
 *      第二个入口只改状态而不重建菜单时，界面上那个勾会与真实状态不一致，且不报错。
 *      因此这里断言"改它的只有托盘那一处"。
 */

section('静音与免打扰')

const quietSource = source('../src/main/quiet.ts')
const permissionsSource = source('../src/main/permissions.ts')

/** 只在**代码**里找（下面那条否则会把注释里那句"不要覆盖 media"当成违规）。 */
const quietCode = quietSource.replace(/\/\*[\s\S]*?\*\//g, '')

check(
  '托盘菜单里有这两项（checkbox，勾选态来自运行期状态）',
  traySource.includes("label: '静音应用声音'") &&
    traySource.includes("label: '免打扰（暂停通知）'") &&
    traySource.includes("type: 'checkbox'") &&
    traySource.includes('checked: quiet.audioMuted') &&
    traySource.includes('checked: quiet.notificationsMuted'),
  '托盘里少了一项 —— 用户就再没有"临时不想被打断"的入口',
)
check(
  '免打扰走的是权限判据，而且两个处理器都传了同一份覆盖（不注入、不伪造通知）',
  permissionsSource.includes('permission === PAGE_NOTIFICATION_PERMISSION') &&
    sessionSource.includes(
      'isPermissionAllowed(permission, contents.getURL(), permissionOverride())',
    ) &&
    sessionSource.includes(
      'isPermissionAllowed(permission, requestingOrigin, permissionOverride())',
    ) &&
    (sessionSource.match(/permissionOverride\(\)/g) ?? []).length >= 2,
  '有一处权限处理器没带上免打扰，或者它绕开了权限层 —— 症状是"检查通过、请求被拒"',
)
check(
  '只覆盖 notifications：media（麦克风 / 摄像头）必须照旧放行，否则通话连不上',
  // 行为断言而不是源码字面量：免打扰走一遍，而 media 一次都不能被波及。
  !isPermissionAllowed('notifications', UPSTREAM_ORIGIN, { notificationsMuted: true }) &&
    isPermissionAllowed('media', UPSTREAM_ORIGIN, { notificationsMuted: true }),
  '免打扰顺手把别的权限也拒了 —— 通话会因为拿不到麦克风而直接失败',
)
check(
  '消息通知由页面自己发（[ADR-0095]）：默认放行，且入口不再把页面通知的 API 拿掉',
  isPermissionAllowed('notifications', UPSTREAM_ORIGIN) &&
    !entrySource.includes('disable-notifications') &&
    !entrySource.includes('applyPageNotificationSuppression'),
  '又回到了"我们代发"：通知里会重新只剩未读总数，看不到谁发的与内容',
)
check(
  '改状态的入口只有托盘那一处（勾选态是快照：第二个入口会让"勾"与真实状态不一致）',
  (traySource.match(/setAudioMuted\(|setNotificationsMuted\(/g) ?? []).length === 2 &&
    !entrySource.includes('setAudioMuted(') &&
    !ipcSource.includes('setAudioMuted(') &&
    !ipcSource.includes('setNotificationsMuted('),
  '有别的文件在改这两个运行期状态 —— 托盘上那个勾会变得不可信，而且不报错',
)
check(
  '是运行期状态、不落盘（重启复位；一个"静默开着的不打扰开关"比复位更难发现）',
  !('audioMuted' in DEFAULT_SETTINGS) &&
    !('notificationsMuted' in DEFAULT_SETTINGS) &&
    !quietCode.includes('saveSettings'),
  '它被写进设置文件了 —— 用户会在几周后才发现自己一直在免打扰里',
)

/**
 * 深链接（[ADR-0083]）。
 *
 * 这一项的风险全在"**把什么拼进了 URL**"与"**哪几条路共用同一句话**"上：
 *
 *   1. 那个 URL 是拿登录态去请求的地址，因此它只能由**一处**拼出来，而且拼进去的形状只能是
 *      数字。第二个拼接点（或一处直接拼接原样字符串）的症状是"命令行里的值被直接交给了窗口"；
 *   2. 认不出来必须返回 `null` —— `argv` 里塞满 Chromium 自己的开关与启动路径，猜错的后果是
 *      "启动时莫名其妙打开了一个对话"；
 *   3. **三条入口共用同一句话**：启动、再次启动（`second-instance`）、页面里点的链接。少接一条
 *      的症状是"命令行能开、点链接不能开"这类半截状态；
 *   4. 打包里那两条声明**缺一不可**：`MimeType` 声明"归我们处理"，`Exec` 的 `%U` 才会把 URL
 *      当参数传进来。"关联建立了、URL 没传进来"的症状正是"点了链接、应用开在首页"。
 */

section('深链接')

const deepLinkSource = source('../src/shared/deep-link.ts')
const deepLinkCode = stripComments(deepLinkSource)
const mainDeepLinkSource = source('../src/main/deep-link.ts')
// `windowSource` 与 `builderConfig` 在上面几节已经读过（同一批文件），这里只补一份去注释的。
const windowCode = stripComments(windowSource)
const packageChecker = source('./verify-package.sh')

check(
  '对话 URL 只有一处拼（`chatUrl()`），而且拼进去的只能是数字',
  deepLinkCode.includes('?phone=${digitOnly(target)}') &&
    !windowCode.includes('?phone=') &&
    !stripComments(mainDeepLinkSource).includes('?phone=') &&
    !stripComments(entrySource).includes('?phone='),
  '有第二处在拼那个 URL，或者拼进去的不是"只取数字"的值 —— 那是把用户输入直接交给窗口',
)
check(
  'URL 是导航出来的，不是注入出来的（`loadURL`，页面一个字节都不碰）',
  windowCode.includes('void window.loadURL(chatUrl(') && !windowCode.includes('executeJavaScript'),
  '深链接绕过了 loadURL —— 那就只剩驱动页面这一条路（INV-1）',
)
check(
  '认不出来就返回 null（号码形状：7–15 位、不以 0 开头；不从任意 URL 里抠数字）',
  parseChatTarget(['--new-chat', '+86 138-0000-0000']) === '8613800000000' &&
    parseChatTarget([`whatsapp://send?phone=8613800000000`]) === '8613800000000' &&
    parseChatTarget([`https://wa.me/8613800000000`]) === '8613800000000' &&
    parseChatTarget(['--new-chat', '07700900123']) === null &&
    parseChatTarget(['--new-chat', '--disable-gpu']) === null &&
    parseChatTarget(['https://example.com/8613800000000']) === null &&
    parseChatTarget(['--profile', 'work']) === null,
  '判据被放宽了 —— 放宽的方向是"启动时打开一个谁也没要求的对话"',
)
check(
  '三条入口共用同一个动作：创建窗口时带目标、second-instance、页面里点的链接',
  entrySource.includes('createMainWindow(chatTargetFromArgv(process.argv))') &&
    entrySource.includes('openChat(window, chatTarget)') &&
    (windowCode.match(/openChat\(window, /g) ?? []).length === 2 &&
    (windowCode.match(/isChatLink\(/g) ?? []).length === 2,
  '有一条路没接上，或者有一处自己拼了 URL —— 症状是"命令行能开、点链接不能开"',
)
check(
  '打包里那两条声明都在（.desktop 的 MimeType 与 Exec 的 %U）',
  builderConfig.includes('x-scheme-handler/whatsapp;') &&
    packageChecker.includes('x-scheme-handler/whatsapp') &&
    packageChecker.includes("'%U'"),
  '少一条的症状都是"点了链接没反应" —— 而它在构建期不可见，只能靠产物断言（pnpm run verify）',
)
check(
  '用户换过图标之后生效的那份 `.desktop` 声明了同一个 scheme（它会盖掉安装的那份）',
  launcherEntry.includes(`MimeType=x-scheme-handler/${CHAT_PROTOCOL};`) &&
    launcherEntry.includes(' %U'),
  '那份同名条目在用户目录里优先 —— 漏了 MimeType 的症状是"换过一次图标之后，点链接什么都不发生"',
)

/**
 * 全屏的退出提示（[ADR-0084]）。
 *
 * 它坏起来是"用户卡在全屏里"这一类：不报错、日志也正常、功能一个都不少。三条断言各自对应
 * 一种安静坏法：
 *
 *   1. **没接上**：上游进了全屏而没人说话。Wayland 下窗口连装饰都没有，用户没有任何可点的
 *      地方（关掉窗口是我们设计的"隐藏到托盘"，连"点那个叉"都不是退路）；
 *   2. **说了错的话**：正文里出现 `F11`（那是我们自己的「窗口全屏」，退不出页面的 HTML 全屏）
 *      —— 用户按了没用，然后连这条提示一起不信；
 *   3. **说得太频繁**：点开一张图也会进全屏，每次都弹会把通知吵到被关掉，而那条通道上还挂着
 *      接管失效的告警。
 */

section('全屏提示')

const fullscreenSource = source('../src/main/fullscreen.ts')
const noticeSource = source('../src/shared/notice.ts')

check(
  '接到的是**页面**发起的全屏（`enter-html-full-screen`），而且挂在主窗口上',
  fullscreenSource.includes("contents.on('enter-html-full-screen'") &&
    entrySource.includes('attachFullscreenHint(mainWindow)'),
  '没接上 —— 上游进全屏之后用户没有任何可点的地方能退出来',
)
check(
  '正文只说 Esc，不写 F11（F11 是我们自己的「窗口全屏」，退不出页面的 HTML 全屏）',
  FULLSCREEN_HINT_BODY.includes('Esc') && !FULLSCREEN_HINT_BODY.includes('F11'),
  '正文里出现了按了没用的键 —— 用户会连这条提示一起不信',
)
check(
  '每个进程只说一次（点开一张图也会进全屏，每次都说会把通知吵到被关掉）',
  trackFullscreenHint(false).announce &&
    trackFullscreenHint(true).announce === false &&
    noticeSource.includes('每个进程只提示一次'),
  '判据被改成了"每次都提示" —— 通知被关掉之后，接管失效那条告警也一起没了',
)

/**
 * 通知点击（[ADR-0092]）。
 *
 * Linux 上 Electron **不会**因为点击通知而激活窗口：网页通知的点击只派发给页面
 * （`NotificationDelegateImpl::NotificationClick()` → `DispatchNonPersistentClickEvent`），
 * 主进程通知也只有一条 `click` 事件。因此"点它有没有反应"完全取决于两处我们自己的代码：
 *
 *   1. `notice.ts` 给每一个 Notification 绑了 click，**并且持有引用** —— 主进程对象被 GC
 *      之后事件永远不会再来；
 *   2. `index.ts` 把"带到哪扇窗口"注入进去了。
 *
 * 漏掉任何一处，症状都是"通知还挂在屏幕上，点它毫无反应"。而它**不报错、不进日志**：
 * 通知显示得很正常，只有点击那一下是死的。
 */

section('通知点击')

const noticeIoSource = source('../src/main/notice.ts')

check(
  '每条通知都绑了 click，并且持有引用（被 GC 掉之后 click 永远不会再来）',
  noticeIoSource.includes("notification.on('click'") &&
    noticeIoSource.includes('live.add(notification)'),
  '点击通知会变成毫无反应 —— 不报错，也不进日志',
)
check(
  '装配处注入了两扇窗口的激活回调（漏一处 = 那一类通知点不动）',
  entrySource.includes('setNoticeActivation(') &&
    entrySource.includes('main:') &&
    entrySource.includes('settings:'),
  '注入缺席时点击落在一个空函数上 —— 看起来和"没修"一模一样',
)
check(
  '词典下载失败的那条指向**设置**（「重试」按钮在那一行上，见 [ADR-0091]）',
  noticeIoSource.includes('spellcheckDictionaryFailureBody(languageCode)') &&
    noticeIoSource.includes("'settings',"),
  '点开之后是一扇没事可做的窗口，用户还得自己去找设置',
)

/**
 * 页面自己那条通知的点击（`src/main/notify-activation.ts` + `src/shared/notify-activation.ts`，
 * [ADR-0096]）。
 *
 * 这条通道的失效**一条都不会报错**：漏了 `addMethodHandler` ⇒ 监视连接在第一条被观察到的
 * `Notify` 之后静默断连（实测：之后收不到任何消息，也没有 `error` 事件）；认领写成按 app 名
 * ⇒ 多实例之间互相抢；日志里带上正文 ⇒ 把**别人**的消息摘要写进磁盘。所以这一节钉的是形状。
 */

section('页面通知的点击（D-Bus 旁听）')

const pageActivationIo = source('../src/main/notify-activation.ts')
const pageActivationLogic = source('../src/shared/notify-activation.ts')

check(
  '监视连接堵掉了 dbus-next 的自动错误回复（漏了 ⇒ 第一条 Notify 之后静默断连）',
  pageActivationIo.includes('addMethodHandler(() => true)'),
  '症状是"头几分钟能用、之后再也不激活"，而且没有任何错误事件',
)

check(
  '装配处开始旁听，动作只有「把聊天窗口带到前面」',
  entrySource.includes('startPageNotificationActivation(') && entrySource.includes('onActivate:'),
  '漏了这一句 = 整条通道没开，界面上看不出任何区别',
)

check(
  '退出时断开总线连接',
  entrySource.includes('stopPageNotificationActivation()'),
  '进程退出本来也会断开，少这一句就说不清有没有泄漏',
)

check(
  '认领靠 pid（`GetConnectionCredentials` → `ProcessID`），不靠 app 名或 hint',
  pageActivationIo.includes('GetConnectionCredentials') &&
    pageActivationIo.includes('ProcessID') &&
    pageActivationIo.includes('process.pid'),
  '按 app 名认会在多实例之间互相抢：点了 A 的通知，B 的窗口跳出来（[ADR-0062]）',
)

check(
  '判据在 shared 里，且不导入 electron（要能被单测直接喂）',
  pageActivationLogic.includes('export function decideClick') &&
    !pageActivationLogic.includes("from 'electron'"),
  '',
)

check(
  '日志里不出现通知正文（旁听连接看得到**所有人**的通知）',
  pageActivationIo
    .split('\n')
    .filter((line) => line.includes('logger.'))
    .every((line) => !/\b(body|summary|title)\b/.test(line)),
  '一条别人的消息摘要进了日志，就是本功能最坏的那个后果',
)

/**
 * 应用菜单（`src/main/menu.ts`）。
 *
 * 我们不调用 `Menu.setApplicationMenu()` 时，Electron 会装**它自己**那份默认菜单：文案是英文、
 * 视图里带着 Force Reload 与 Toggle DevTools、帮助里一条会去打开 electronjs.org 的
 * "Learn More about Electron"。三扇窗口都是 `autoHideMenuBar: true`，菜单栏平时看不见 ——
 * 但 Alt 一按就出来，**而且它的快捷键一直在生效**：那份默认菜单既是暴露面，又是"Ctrl+Q 能不能
 * 退出 / 能不能缩放"的实际来源。因此这一节钉住三件事：装的是我们的那份、每个 `role` 都有中文
 * `label`（与右键菜单同一条纪律）、默认菜单里那几个入口没有溜回来。
 */

section('应用菜单')

const appMenuSource = source('../src/main/menu.ts')
/**
 * 只看**代码**，把块注释去掉：这份文件的注释**正当**要提到那几个名字（它解释的正是"我们为什么不
 * 装 DevTools / Learn More"）。断言不该把"写清了理由"当成违规。
 */
const appMenuCode = appMenuSource.replace(/\/\*[\s\S]*?\*\//g, '')
const appMenuRoleItems = appMenuCode.match(/\{\s*role:\s*'[a-zA-Z]+'[^}]*\}/g) ?? []

check(
  '应用菜单里每个 role 项都带 label（默认文案取自 Chromium 的 locale，可能是英文）',
  appMenuRoleItems.length > 0 && appMenuRoleItems.every((item) => item.includes('label:')),
  appMenuRoleItems.length === 0
    ? 'menu.ts 里找不到任何 role 项 —— 菜单模板被改过了？'
    : `这几项没有 label：${appMenuRoleItems.filter((item) => !item.includes('label:')).join(' ')}`,
)
check(
  '内核的调试入口与 Electron 的帮助项没有溜回来（DevTools / Force Reload / Learn More）',
  !/toggleDevTools|forceReload|Learn More/.test(appMenuCode),
  'menu.ts 里出现了 DevTools / Force Reload / Learn More —— 它们不该由一次按键触达',
)
check(
  '菜单在窗口创建之后才装，且三扇窗口都传了进去',
  entrySource.indexOf('installApplicationMenu(') > entrySource.indexOf('= createMainWindow()') &&
    entrySource.includes('files: filesWindow') &&
    entrySource.includes('settings: settingsWindow') &&
    entrySource.includes('main: mainWindow'),
  '菜单装早了拿不到窗口引用，或者漏了某一扇 —— 那一项会变成"点了没反应"',
)

const mainSourceFiles = sourceFiles(join(srcRoot, 'main'))
check(
  '拼写检查的两个设置项在主进程里都有读者（能改的就一定真的会被执行）',
  ['spellcheck', 'spellcheckLanguages'].every((key) =>
    mainSourceFiles.some(
      (file) => basename(file) !== 'settings.ts' && readFileSync(file, 'utf8').includes(key),
    ),
  ),
  '有一个设置项只有界面上的一行，没有任何主进程代码读它',
)

/**
 * 「`docs/decisions.md` 的索引表」与正文标题必须**一一对应**。
 *
 * 为什么值得两条断言：索引表是这份**唯一事实源**的目录，而它三种坏法都是**静默**的 ——
 *
 *   - **漏一行索引**（[ADR-0057] 有正文、索引里没有）：那一条从目录里消失，读者以为它不存在；
 *   - **漏一段正文**（[ADR-0072] 有索引、正文没写）：索引里那个 `#adr-xxxx` 成为**断链**，而
 *     代码里已经在引用它（`src/main/spellcheck.ts` 的注释就写着 `[ADR-0072]`）；
 *   - **插新行时插错位置**（0072 曾经排在 0071 之前）：编号顺序被打乱。
 *
 * 三者都不报错、应用也一切正常，因此只能在这里挡。刻意**不**检查索引文字与正文是否语义一致
 * （那需要读语义），只钉住"编号连续、升序、且两侧都存在"。
 */
const decisionsDoc = source('../docs/decisions.md')
const indexedAdrs = [...decisionsDoc.matchAll(/^\| \[(\d{4})\]\(#adr-\d{4}\) \|/gm)].map(
  (match) => match[1],
)
const headedAdrs = [...decisionsDoc.matchAll(/^## ADR-(\d{4})\s*$/gm)].map((match) => match[1])
const indexedSet = new Set(indexedAdrs)
const headedSet = new Set(headedAdrs)
const missingHeading = indexedAdrs.filter((number) => !headedSet.has(number))
const missingIndex = headedAdrs.filter((number) => !indexedSet.has(number))
check(
  'ADR 索引表与正文标题一一对应（漏索引 = 那一节从目录里消失；漏正文 = 索引指向一个断链）',
  indexedAdrs.length > 0 && missingHeading.length === 0 && missingIndex.length === 0,
  indexedAdrs.length === 0
    ? 'docs/decisions.md 里找不到索引行 —— 表头或者行的写法改过了？'
    : missingHeading.length > 0
      ? `这些索引行指向不存在的正文：${missingHeading.join(', ')}`
      : `这些正文没有索引行：${missingIndex.join(', ')}`,
)
check(
  'ADR 编号连续、升序：正文是 0001 起逐号 +1，索引表也保持同样的次序',
  headedAdrs.map(Number).every((number, offset) => number === offset + 1) &&
    indexedAdrs
      .map(Number)
      .every((number, offset, all) => offset === 0 || number > all[offset - 1]),
  `索引次序：${indexedAdrs.join(', ')}`,
)

// ---------------------------------------------------------------------------
// 20. 实例隔离（多实例）
// ---------------------------------------------------------------------------
//
// 多实例唯一的杠杆是"按实例改写 `userData`"（`main/index.ts`），而它成立依赖三件**顺序**上
// 的事：先解析实例、再改写 userData/sessionData、最后才申请单实例锁。任何一件错位都**不会
// 报错**，只会让两个实例抢同一份登录态（症状是随机要重新扫码）。因此这一节除了断言判据，
// 还断言源码里的先后次序。

section('实例隔离')

check(
  '默认实例派生的名字与改动之前逐字符相同（升级不该让用户的数据"消失"）',
  instancePartition(DEFAULT_INSTANCE_ID) === 'persist:waachat' &&
    withInstanceSuffix(ARCHIVE_DIR_BASE_NAME, DEFAULT_INSTANCE_ID) === 'WaaChat_files',
  '默认实例的名字变了 —— 既有用户的登录态与归档会找不到自己',
)
check(
  '不同实例派生出的分区名两两不同',
  new Set([DEFAULT_INSTANCE_ID, 'work', 'home'].map(instancePartition)).size === 3,
)
check(
  '非法实例名给的是错误，而不是"悄悄回落到默认实例"',
  parseInstanceArg([INSTANCE_ARG, 'Work']).error !== null &&
    parseInstanceArg([INSTANCE_ARG, 'default']).error !== null &&
    parseInstanceArg([]).error === null,
  '有一个非法输入被当成了合法实例',
)
check(
  '旧参数名（--instance）报错，而不是被当成陌生参数无视（无视＝静默启动默认实例）',
  parseInstanceArg([LEGACY_INSTANCE_ARG, 'work']).error !== null &&
    parseInstanceArg([`${LEGACY_INSTANCE_ARG}=work`]).error !== null &&
    // 新名字照旧生效（改名不许把生效的那个也弄坏）
    parseInstanceArg([INSTANCE_ARG, 'work']).error === null &&
    // 报错时保留用户本来想要的那个名字：漏判 error 的调用方最多落到一个空目录。
    parseInstanceArg([LEGACY_INSTANCE_ARG, 'work']).id === 'work',
  '旧脚本会被静默地落到默认实例的数据上 —— 那正是改名最危险的失败方式',
)
// ⚠️ "两个常量不是同一个字符串"不需要断言：它们都是字面量类型，写成 `INSTANCE_ARG ===
// LEGACY_INSTANCE_ARG` 是**编译错误**（TS2367）。类型系统在这一点上比运行时断言更早发现问题。

// `entrySource` 复用上面"拼写检查与 UA"那一节读到的同一份文本（词典源写得够不够早就出自它）。

/**
 * 指针都带上调用形状（`app.setPath('userData',` 而不是 `setPath`）—— 上面那几段注释里就写着
 * 这些方法名，只按名字找会指到注释上，于是这条断言在"代码顺序真的被改反"时也不变红。
 */
const atResolve = entrySource.indexOf('= resolveInstance()')
const atUserData = entrySource.indexOf(`app.setPath('userData',`)
const atSessionData = entrySource.indexOf(`app.setPath('sessionData',`)
const atLock = entrySource.indexOf('if (!app.requestSingleInstanceLock())')

check(
  '启动顺序：解析实例 → 改 userData/sessionData → 才申请单实例锁',
  atResolve > -1 && atUserData > atResolve && atSessionData > atUserData && atLock > atSessionData,
  '顺序错了不会报错，只会让两个实例抢同一份登录态',
)

const pathSource = source('../src/main/paths.ts')

check(
  '按实例分叉的目录都由 withInstanceSuffix() 派生（不许另起一套命名）',
  (pathSource.match(/withInstanceSuffix\(/g) ?? []).length >= 3,
  '归档 / 缓存 / 日志三个目录里至少有一个没有跟着实例走',
)
const userDataReaders = ['../src/main/settings.ts', '../src/main/integration/appicon.ts'] as const

check(
  'userData 下的路径必须在**调用时**才算（模块级常量会让所有实例共用同一份数据）',
  userDataReaders.every((file) => {
    const text = source(file)
    return (
      text.includes(`getPath('userData')`) &&
      // 只看**顶格**的赋值：函数体里的同名写法是每次调用重算，那是正确的。
      !/^(?:const|let|var)\s+\w+\s*=[^\n]*getPath\('userData'\)/m.test(text)
    )
  }),
  '有一个文件在模块顶层捕获了 userData —— 多实例下它会写到另一个实例的数据里，而且不报错',
)
check(
  '没有写死的会话分区名了（分区必须按实例解析）',
  !/SESSION_PARTITION|fromPartition\('persist:/.test(
    entrySource + pathSource + source('../src/main/window.ts') + source('../src/main/ipc/index.ts'),
  ),
)
check(
  'shared/instance.ts 与 main/instance.ts 都不导入 electron（判据要能在没有 Electron 的环境里断言）',
  !source('../src/shared/instance.ts').includes(`from 'electron'`) &&
    !source('../src/main/instance.ts').includes(`from 'electron'`),
)
check(
  '用户级 .desktop 条目与 autostart 条目都只由默认实例维护',
  source('../src/main/integration/appicon.ts').includes('usingDefaultInstance()') &&
    source('../src/main/integration/login.ts').includes('usingDefaultInstance()'),
  '两个实例会互相覆写同一份系统条目，而外面看不出是谁写的',
)

// ---------------------------------------------------------------------------

section('结论')
if (failures === 0) {
  console.log('\u001b[32m自检通过。\u001b[0m')
  console.log('· 这些断言只覆盖"约定未被破坏"，不能替代一次真实的点击。')
} else {
  console.log(`\u001b[31m${failures} 项断言失败。\u001b[0m`)
  console.log('· 若与上游行为变化有关，请附上本输出提 issue（模板见 .github/ISSUE_TEMPLATE/）。')
}

process.exit(failures === 0 ? 0 : 1)
