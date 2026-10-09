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

import { isAllowedTarget } from '../src/main/archive/migrate'
import { sanitizeFileName } from '../src/main/archive/naming'
import { deriveCacheKey, isMediaRequest } from '../src/main/capture/cachekey'
import { CARRIED_HEADERS, carriedHeaders } from '../src/main/capture/headers'
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
  defaultArchiveDir() === join(home, 'Downloads', 'WaaChat_files'),
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

  note(`归档目录：${archive}`)
  note(`正文 ${blobs.length} 个，链接目录条目 ${entries.includes('.open') ? '有' : '无'}`)

  // 残留的临时文件说明上次进程是被 kill 的（正常退出不会留下）。
  // 它不是错误 —— 下次启动会清扫掉 —— 但知道这件事有助于解释磁盘占用。
  check(
    '没有残留的半成品',
    leftovers.length === 0,
    `${leftovers.length} 个 .part-*，下次启动会清掉`,
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

section('结论')
if (failures === 0) {
  console.log('\u001b[32m自检通过。\u001b[0m')
  console.log('· 这些断言只覆盖"约定未被破坏"，不能替代一次真实的点击。')
} else {
  console.log(`\u001b[31m${failures} 项断言失败。\u001b[0m`)
  console.log('· 若与上游行为变化有关，请附上本输出提 issue（模板见 .github/ISSUE_TEMPLATE/）。')
}

process.exit(failures === 0 ? 0 : 1)
