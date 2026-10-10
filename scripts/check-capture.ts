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
  SETTINGS_ROW_ORDER.length === Object.keys(DEFAULT_SETTINGS).length + 1 &&
    new Set(SETTINGS_ROW_ORDER).size === SETTINGS_ROW_ORDER.length &&
    SETTINGS_SECTIONS.every((section) => section.title.trim() !== '' && section.rows.length > 0),
)

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
// ADR-0043 撤销了 INV-2 的 lint 守卫，因此这条只能靠 ADR + 本断言兜住，而不是 lint。
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

section('结论')
if (failures === 0) {
  console.log('\u001b[32m自检通过。\u001b[0m')
  console.log('· 这些断言只覆盖"约定未被破坏"，不能替代一次真实的点击。')
} else {
  console.log(`\u001b[31m${failures} 项断言失败。\u001b[0m`)
  console.log('· 若与上游行为变化有关，请附上本输出提 issue（模板见 .github/ISSUE_TEMPLATE/）。')
}

process.exit(failures === 0 ? 0 : 1)
