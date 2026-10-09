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
import { dirname, join } from 'node:path'

import { ARCHIVE_FILE_MODE } from '../src/main/archive/blobs'
import { isAllowedTarget } from '../src/main/archive/migrate'
import { archiveNameCandidates, sanitizeFileName } from '../src/main/archive/naming'
import { STAGING_DIR_NAME, isEntryName } from '../src/main/capture/cache-files'
import { deriveCacheKey, isMediaRequest } from '../src/main/capture/cachekey'
import { CARRIED_HEADERS, carriedHeaders } from '../src/main/capture/headers'
import { PDF_DOWNLOAD_MIME, isPdfResponse } from '../src/main/capture/pdf'
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
import { APP_ID, DESKTOP_FILE_NAME } from '../src/shared/constants'
import { isDocumentPreviewPage } from '../src/shared/upstream'
import { DEFAULT_SETTINGS, RESTART_REQUIRED_SETTINGS } from '../src/shared/types'
import {
  archiveDir,
  ciphertextCacheDir,
  defaultArchiveDir,
  indexDbPath,
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

const archive = archiveDir()
if (existsSync(archive)) {
  check(
    `归档目录权限为 0700`,
    (statSync(archive).mode & 0o777) === 0o700,
    `实际 ${(statSync(archive).mode & 0o777).toString(8)}`,
  )

  const entries = readdirSync(archive)
  const blobs = entries.filter((name) => !name.startsWith('.'))
  const leftovers = entries.filter((name) => name.startsWith('.part-'))

  const legacyNames = blobs.filter((name) => /^[0-9a-f]{64}$/.test(name)).length

  note(`归档目录：${archive}`)
  note(
    `正文 ${blobs.length} 个${legacyNames === 0 ? '' : `（其中 ${legacyNames} 个是旧布局的哈希名，打开时会补上只读）`}`,
  )

  // 残留的临时文件说明上次进程是被 kill 的（正常退出不会留下）。
  // 它不是错误 —— 下次启动会清扫掉 —— 但知道这件事有助于解释磁盘占用。
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
  const legacy = (name: string): boolean => /^[0-9a-f]{64}$/.test(name)
  const writable = blobs.filter(
    (name) => !legacy(name) && (statSync(join(archive, name)).mode & 0o777) !== ARCHIVE_FILE_MODE,
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
  const bins = readdirSync(cache).filter((name) => name.endsWith('.bin'))
  note(`密文缓存：${bins.length} 项，位于 ${cache}`)
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
// 9. PDF 交给系统应用
// ---------------------------------------------------------------------------
//
// 两条纯规则，都属于"改了没人会立刻发现"的那一类（挂点要跑 Electron，这里只锁判据，
// 见 ADR-0029）：
//   - 预览页判据放宽一点点，上游的预览页就会重新被加载，应用内又出现内核阅读器的预览；
//   - MIME 判据漏掉，PDF 就会继续被内核渲染而不是下载 —— 而"下载"是文件落到系统阅读器的
//     唯一路径（接管点 A）。

section('PDF 交给系统应用')

check(
  '认得上游的文档预览页',
  isDocumentPreviewPage('https://webtp.whatsapp.net/pdf-viewer/?locale=zh_CN'),
)
check(
  '同域下的其它路径不算预览页',
  !isDocumentPreviewPage('https://webtp.whatsapp.net/rsrc.php/x.js'),
)
check(
  '站外的同路径伪装不算',
  !isDocumentPreviewPage('https://webtp.whatsapp.net.evil.com/pdf-viewer/'),
)
check(
  '预览页判据不限定 host（上游换域时不会静默放行）',
  isDocumentPreviewPage('https://web.whatsapp.com/pdf-viewer/'),
)
// 两条都属于"改了没人会立刻发现"的约定（ADR-0030）：默认打开会让没做过选择的用户撞上
// ADR-0029 的已知限制（点 PDF 没反应），而加进"重启后生效"名单则会让一个立刻生效的开关
// 顶着一个不成立的徽标。
check('"禁用 PDF 预览"默认关闭', DEFAULT_SETTINGS.disablePdfPreview === false)
check(
  '"禁用 PDF 预览"不在"重启后生效"名单里（判据每请求现读）',
  !RESTART_REQUIRED_SETTINGS.includes('disablePdfPreview'),
)
check(
  'PDF 的 MIME 判据认 application/pdf（含带参数），不认 octet-stream',
  isPdfResponse('application/pdf') &&
    isPdfResponse('application/pdf; name=x.pdf') &&
    !isPdfResponse('application/octet-stream'),
)
check('降级方向是 octet-stream（内核据此走下载）', PDF_DOWNLOAD_MIME === 'application/octet-stream')

// ---------------------------------------------------------------------------
// 10. 网络：值得重试的错误
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

section('结论')
if (failures === 0) {
  console.log('\u001b[32m自检通过。\u001b[0m')
  console.log('· 这些断言只覆盖"约定未被破坏"，不能替代一次真实的点击。')
} else {
  console.log(`\u001b[31m${failures} 项断言失败。\u001b[0m`)
  console.log('· 若与上游行为变化有关，请附上本输出提 issue（模板见 .github/ISSUE_TEMPLATE/）。')
}

process.exit(failures === 0 ? 0 : 1)
