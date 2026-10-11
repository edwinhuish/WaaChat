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
  instancePartition,
  parseInstanceArg,
  withInstanceSuffix,
} from '../src/shared/instance'
import {
  DEFAULT_SPELLCHECK_LANGUAGES,
  SPELLCHECK_LANGUAGES,
  normalizeSpellcheckLanguages,
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
  '只把内核实有的词典交给它，被丢掉的那些留在返回值里（供调用点记日志）',
  (() => {
    const resolved = resolveSpellcheckLanguages('en-US,de', ['en-US'])
    return resolved.applied.join(',') === 'en-US' && resolved.rejected.join(',') === 'de'
  })(),
)
check(
  '空列表被收敛成默认："一门都不查"与"功能坏了"在用户看来没有区别',
  normalizeSpellcheckLanguages('') === DEFAULT_SPELLCHECK_LANGUAGES &&
    normalizeSpellcheckLanguages('de-DE') === DEFAULT_SPELLCHECK_LANGUAGES,
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
 * 一门一行、每行一颗 `⋯` 的清单"，点开是一张带搜索的模态清单。
 *
 * 它坏起来是静默的 —— 类名改了却忘了改样式表，控件照样能勾、能存，只是**看不出是个控件**
 * （没有边框，对话框既没有遮罩也没有尺寸）。因此把两边一起断言。
 */
const LANGUAGE_UI_CLASSES = [
  'language-field',
  'language-head',
  'language-items',
  'language-item',
  'language-name',
  'language-code',
  'language-progress',
  'language-status',
  'language-menu-button',
  'language-menu',
  'language-menu-item',
  'language-dialog',
  'language-search',
  'language-list',
  'language-option',
]
check(
  '拼写词典是"表头 + 一门一行的清单（带下载进度）+ 一张可搜索的模态清单"，且每一处的样式都真的有定义（[ADR-0070] / [ADR-0071]）',
  LANGUAGE_UI_CLASSES.every(
    (name) => settingsViewSource.includes(`'${name}'`) && stylesheet.includes(`.${name} {`),
  ),
  '类名与样式表对不上：控件会静默失去外观（或者那一整块根本没画出来）',
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
 * 「至少要留一门」在**清单那一侧**的闸门（[ADR-0070]）：只剩一门时 `⋯` 里那一项是禁用的。
 *
 * 它与对话框里那条（草稿为空时禁用「确定」）是两个必须同时在位的落点 —— 少了这一条，用户能
 * 把清单删空，而空列表会被 `normalizeSpellcheckLanguages()` 收敛回默认值：看起来像"它自己变
 * 回去了"。这里只能做文本扫描，因此它挡的是**被人顺手删掉**，不是"逻辑写错了"。
 */
check(
  '「移除」在只剩一门时是禁用的（[ADR-0070]："至少要留一门"的另一处落点）',
  settingsViewSource.includes('selected.length > 1') &&
    settingsViewSource.includes('disabled: !removable'),
  '「移除」的禁用条件不见了：删到一门都不剩时，设置会被悄悄收敛回默认值',
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

const entrySource = source('../src/main/index.ts')

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
