/**
 * 会话配置。
 *
 * 两个接管点都挂在这里，因此 `configureSession` **必须**在任何窗口创建之前调用
 * —— 晚一步就会错过早期的下载与请求。
 *
 * 它是**异步**的：密文缓存的启动对账要读写缓存目录（可能有上万个条目），按
 * `ai/CONVENTIONS.md` 的纪律不能拿同步 IO 卡住主进程。
 */

import type { Session } from 'electron'

import { trackDenial, type DenialPath } from '../shared/permission-log'
import type { Settings } from '../shared/types'
import { isUpstreamOrigin } from '../shared/upstream'
import { buildUserAgent, isCleanUserAgent } from '../shared/user-agent'
import { enforceCacheLimit, reconcileCiphertextCache } from './capture/cache-files'
import { attachDownloadCapture } from './capture/download'
import { onHealthChange } from './capture/health'
import { attachCiphertextCache } from './capture/protocol'
import { CHANNELS } from './ipc/channels'
import { announceCaptureFailure, announceDictionaryFailure, markCaptureHealthy } from './notice'
import { logger } from './logger'
import { followPageLanguage, watchPageLanguage } from './page-language'
import { isPermissionAllowed } from './permissions'
import { quietState } from './quiet'
import {
  applySpellcheck,
  onDictionaryStatusChange,
  replayMissingDictionaryStatus,
  watchSpellcheck,
} from './spellcheck'
import { getSettingsWindow } from './window'

/**
 * 把 UA 写到会话上（[ADR-0060] 决定 4）。
 *
 * 为什么必须是**会话级**且**早于任何窗口**：`session.setUserAgent()` 明确"不影响已存在的
 * WebContents"，晚一步就只能靠一次页面重载补回来 —— 而那时用户已经在看着页面了。
 *
 * ⚠️ 承载上游页面的窗口（`window.ts`）因此**不**自己设 UA：两处各设一次会互相覆盖，
 * 而且**不报任何错**（自检第 19 节断言这一点）。
 *
 * 为什么现在只剩 UA：[ADR-0066] 之前这里还传了第二个参数 `acceptLanguages`（Electron 唯一能设
 * `Accept-Language` 的入口），用来下发用户选的界面语言。那一项撤掉之后不再传 —— 请求头回到内核
 * 按系统 locale 生成的默认值，也就是普通浏览器的样子。
 */
function applyUserAgent(ses: Session): void {
  const userAgent = buildUserAgent(process.versions.chrome)

  ses.setUserAgent(userAgent)

  // 记的是"UA 干净吗"，不是整条头：上游会据此判定浏览器是否受支持，而它是这一类改动最容易
  // 静默坏掉的地方（`Electron/` 标记一旦漏出去，页面会出现什么行为不由我们决定）。
  logger.info('session: user agent applied', { userAgentClean: isCleanUserAgent(userAgent) })
}

/**
 * 订阅与词典有关的那四个事件（[ADR-0073]）。
 *
 * ⚠️ **必须在会话被创建之后立刻调用，早于任何 `await`。** 这一条是实测出来的时序：词典已经在
 * 磁盘上时，内核在 `session.fromPartition()` 之后 **4ms** 就把
 * `spellcheck-dictionary-initialized` 发出去了（两趟本机探针），而那四个事件**不会重发**
 * —— 把同一个语言列表再设一遍，内核什么都不做（[ADR-0072] 实测）。
 *
 * 它原来排在 `configureSession()` 里，也就是 `applySpellcheck()` 之后；而那前面隔着一次
 * `await resolveAccountKey()`（一个 cookie 的 IPC 往返，实测约 8ms）。晚了这几毫秒的代价不是
 * 报错，而是**那几格永远是空槽** —— 而"空槽"与"这门词典本来就不需要下载"在界面上长得一模一样，
 * 用户读到的就是"词典一直没下载"。安装版 v1.1.0 的日志里因此**一条词典事件都没有**。
 *
 * 通知在这里**注入**（而不是让 `spellcheck.ts` 自己 import `notice.ts`）：那个文件只
 * `import type` electron，是本模块能把它读进离线自检的前提，理由写在它文件头。
 */
export function attachDictionaryWatch(ses: Session, getSettings: () => Settings): void {
  watchSpellcheck(ses, getSettings, announceDictionaryFailure)
}

/**
 * 「免打扰」（[ADR-0082]）交给权限判据的那一份运行期覆盖。
 *
 * **每次调用都重新读**，而不是在装配时取一份快照：托盘里那个勾随时可以变，而权限判据是
 * **每一次请求**都要过的一道闸。取快照的症状是"勾了免打扰，通知照旧弹"，且只有在重启之后
 * 才会"自己好了"—— 那是最难查的一类。
 */
function quietOverride(): { readonly notificationsMuted: boolean } {
  return { notificationsMuted: quietState().notificationsMuted }
}

/**
 * 已经记过的"拒绝组合"（规则与理由见 `shared/permission-log.ts`）。
 *
 * 模块级可变状态：两个处理器必须共用同一份"已经说过了"，而每个进程只承载一个实例，因此不需要
 * 按会话分。与 `notice.ts` 里那几个 `announced*` 是同一种东西。
 */
let seenDenials: ReadonlySet<string> = new Set()

/**
 * 记一条"我们拒了某个权限"。
 *
 * ⚠️ 级是 `warn`：这几行是**取证**用的（[ADR-0035] 的取证清单、[ADR-0085] 的屏幕共享），而它
 * 同时是用户能自己判断"这个功能没反应是不是被我们拒了"的唯一线索 —— 写在 debug 级等于让它消失
 * （默认级别下看不到）。
 *
 * 两条路各用一条消息：它们对应上游完全不同的行为（真的请求 vs 只检查），混成一条会让我们在
 * 取证时读不出卡在哪一环。
 */
function reportDenial(path: DenialPath, permission: string, fromUpstream: boolean): void {
  const tracking = trackDenial(seenDenials, { path, permission, fromUpstream })
  seenDenials = tracking.seen

  if (!tracking.log) return

  logger.warn(path === 'request' ? 'permission denied' : 'permission check denied', {
    permission,
    fromUpstream,
  })
}

export async function configureSession(ses: Session, getSettings: () => Settings): Promise<void> {
  // 这一次性决策（权限、密文缓存开关）用当时的取值。订阅层次的选择在会话建立时
  // 就固定了，运行期改不了 —— 见 shared/types.ts 的 RESTART_REQUIRED_SETTINGS。
  //
  // **拼写检查**在设置被改动时会重新写到会话上（见 ipc/index.ts 的 applySettings），因此这里
  // 只是启动时的首次装配。
  //
  // **界面语言**曾经也在这里落（`--lang` + 请求头 + 网页版那条偏好 cookie，[ADR-0063] /
  // [ADR-0065]）。[ADR-0066] 把"改它"那一项整个撤掉了：登录之后语言由**账号**决定，我们做的任何
  // 固定都会被页面改回去，于是连 UA 之外的那些会话级语言设置也一并去掉。
  //
  // ⚠️ 那件事在 [ADR-0088] 之后回来了**一半**：我们仍然不改页面的语言，但会**读**它自己记着的那
  // 一条（`wa_web_lang_pref`，见下面"语言与输入"那一节），用它选出拼写检查的默认词典。写它仍然是
  // 禁止的（自检第 19 节有一条负向断言看着这件事）。
  const settings = getSettings()

  // --- 权限 -----------------------------------------------------------------
  // 判据在 `permissions.ts`：**来源 + 类型**双向白名单，不导入 electron，因此单测与离线自检
  // 都能断言"哪些权限被放行"（[ADR-0035]）。这一层只负责把它接到会话上，并在拒绝时留痕 ——
  // 一条 `permission denied` 日志是用户能自己判断"这个功能没反应是不是被我们拒了"的唯一线索。
  ses.setPermissionRequestHandler((contents, permission, callback) => {
    const fromUpstream = isUpstreamOrigin(contents.getURL())
    const allowed = isPermissionAllowed(permission, contents.getURL(), quietOverride())

    if (!allowed) reportDenial('request', permission, fromUpstream)

    callback(allowed)
  })

  // 有些 Web API 只做权限**检查**（不发起请求），因此两个处理器必须用同一套判据 ——
  // 只接一边的症状是"检查通过、请求被拒"或反过来。托盘的「免打扰」也在这套判据里（[ADR-0082]）。
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    const fromUpstream = isUpstreamOrigin(requestingOrigin)
    const allowed = isPermissionAllowed(permission, requestingOrigin, quietOverride())

    /**
     * ⚠️ 这一条是**新增**的，而且是"共享屏幕到底卡在哪一环"这个问题的关键证据（[ADR-0085]）：
     * 检查被拒时我们从前**什么都不说** —— 于是当某个 API 只检查、不请求时，用户报"点了没反应"
     * 而日志里一片干净，我们会以为上游根本没试过，接着去别处找原因。
     */
    if (!allowed) reportDenial('check', permission, fromUpstream)

    return allowed
  })

  /**
   * 屏幕共享。
   *
   * 必须显式提供处理器，否则 getDisplayMedia 会直接失败。`useSystemPicker` 让
   * Wayland 下的 xdg-desktop-portal 选择器接管 —— 这比自己枚举屏幕列表更正确，
   * 也避免把用户的所有窗口标题暴露给页面。
   *
   * 若平台不提供系统选择器，处理器会被调用，此时拒绝而不是替用户随便选一个源。
   */
  ses.setDisplayMediaRequestHandler(
    () => {
      logger.warn('display media requested but no system picker available; denying')
    },
    { useSystemPicker: true },
  )

  // --- 语言与输入 -------------------------------------------------------------
  // UA 必须在创建任何窗口之前写进会话（见上面那个函数的说明）；拼写检查随后装配。
  applyUserAgent(ses)

  /**
   * 内嵌页面的界面语言 → 拼写检查的默认词典（[ADR-0088]）。**只读**那条 cookie，从不写它
   * （[ADR-0066] 撤掉的是"改页面语言"这件事）。
   *
   * ⚠️ **必须早于下面那次 `applySpellcheck()`**，而且下面那次传的必须是 `getSettings()` 而不是
   * 上面那份 `settings` 快照：这一支可能刚把清单换掉（首次运行那条路），拿动身前的那一份去装配
   * 会让内核查的语言与设置里显示的不是同一个，顺带还让内核白下一门 `en-US`（[ADR-0072]）。
   *
   * ⚠️ 它**不**破坏 [ADR-0073] 那条时序：词典事件的订阅仍然紧跟着 `session.fromPartition()`，
   * 由 `index.ts` 在任何 `await` 之前接上。这里晚的是"把语言列表交上去"，那一步随时可以做。
   */
  await followPageLanguage(ses, getSettings)

  /**
   * 拼写检查只需要在启动时装配一次：`setSpellCheckerLanguages()` 对已存在的输入框**立即**生效
   * （拼写检查是每一次输入时向内核要素材的，不是页面自己渲染的），因此它不需要重载页面。
   *
   * 事件订阅**不在这里** —— 它必须早得多（见 {@link attachDictionaryWatch}，[ADR-0073]），
   * 因此由 `index.ts` 在会话被创建之后立刻接上。这一层只负责把用户勾的那一组交上去。
   */
  applySpellcheck(ses, getSettings())

  /**
   * 界面语言**变了**时再跟一次（[ADR-0088]）：页面登录之后会写下账号语言，用户在手机上改了语言
   * 也会走到这里。
   *
   * ⚠️ 同样必须早于任何窗口：页面装载之后几秒内就会写那条 cookie。
   */
  watchPageLanguage(ses, getSettings)

  /**
   * 兜底重播（[ADR-0073]）：回头看一眼"该有状态的语言里还有谁没有"。正常路径下**一个都没有**
   * —— 订阅早于内核那四条通知，因此它们都听见了；这一支只兜住"漏听"这一种情况，把那一格从
   * 空槽救成蓝条（或红条），而不是让它在整个运行期里都读作"没下载"。
   */
  replayMissingDictionaryStatus(ses, getSettings)

  /**
   * 把词典状态的每一次变化推给**设置窗口**（[ADR-0071]）。进度条长在设置页里（[ADR-0025]），
   * 别的窗口没有它的宿主 —— 与 `ipc/index.ts` 推迁移进度时是同一条判断。
   *
   * 这里只订阅、不做别的：状态表本身归 `spellcheck.ts`（它只 `import type` electron），
   * 而"推给谁"是这一层才知道的事。窗口还不存在（或已关掉）时**什么都不做** —— 状态留在
   * 主进程里，等设置窗口打开时由 `settings:dictionary-status` 一次性读走。
   */
  onDictionaryStatusChange((statuses) => {
    const window = getSettingsWindow()
    if (window === null || window.isDestroyed()) return
    window.webContents.send(CHANNELS.dictionaryStatusChanged, statuses)
  })

  // --- 接管点 A：下载事件 -----------------------------------------------------
  // 这一层是"点击即开"的全部实现，也是 M1 的验收目标。
  // 传的是**读取函数**而不是快照：用户在偏好设置里改了"点击时自动打开"，
  // 要立刻生效，而不是等下次重启。
  attachDownloadCapture(ses, getSettings)

  // --- 接管点 B：密文缓存 -----------------------------------------------------
  // 可关闭。关闭后只影响"二次打开是否联网"，不影响正确性。
  //
  // 开关的切换在设置窗口里就完成了（事务式，ADR-0027）；这里**每次启动**再把磁盘上的缓存
  // 对账到当前设置，再决定挂不挂协议层：关掉就清掉旧密文（设置说不要留在本机，磁盘上也
  // 就不该有），开启则保留可命中的条目、只清不可能命中的残留。判据是"目录内容 vs 当前设置"
  // 而不是"上次是什么"，所以它幂等、无状态 —— 它现在是**崩溃恢复的兜底**（ADR-0026）。
  //
  // 位置也重要：必须早于任何窗口与请求，否则可能出现"把正在写的条目当残留删掉"。
  await reconcileCiphertextCache(settings.enableCiphertextCache)

  /**
   * 对账之后按上限淘汰一次（[ADR-0049]）：上次退出时可能超过上限（比如用户把上限调小、
   * 之后再没下载过任何东西），而对账本身只让磁盘与**开关**一致，不管容量。
   */
  await enforceCacheLimit(settings.cacheMaxBytes)

  if (settings.enableCiphertextCache) {
    attachCiphertextCache(ses, getSettings)
  }

  /**
   * 接管失效必须**可见**（`architecture.md` 第 5 节："允许失效，不允许静默失效"）。
   *
   * 以前这是设置窗口顶栏那几颗标签的职责。顶栏整个去掉之后（[ADR-0042]），改由**系统通知**
   * 承担：成功时什么都不做（正常状态不值得占用户视线），失效时每种原因提示一次。
   * 订阅放在这里而不是 `notice.ts` 里，是为了让判据与 IO 保持分开 ——
   * `capture/health.ts` 仍然只 `import type` electron。
   */
  onHealthChange((health) => {
    if (health.lastError === null) {
      markCaptureHealthy()
      return
    }

    announceCaptureFailure(health.lastError)
  })

  logger.info('session configured', {
    ciphertextCache: settings.enableCiphertextCache,
    openOnCapture: settings.openOnCapture,
  })
}
