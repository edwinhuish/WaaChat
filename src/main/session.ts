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

import type { Settings } from '../shared/types'
import { isUpstreamOrigin } from '../shared/upstream'
import { buildUserAgent, isCleanUserAgent } from '../shared/user-agent'
import { enforceCacheLimit, reconcileCiphertextCache } from './capture/cache-files'
import { attachDownloadCapture } from './capture/download'
import { onHealthChange } from './capture/health'
import { attachCiphertextCache } from './capture/protocol'
import { announceCaptureFailure, announceDictionaryFailure, markCaptureHealthy } from './notice'
import { logger } from './logger'
import { isPermissionAllowed } from './permissions'
import { applySpellcheck, watchSpellcheck } from './spellcheck'

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

export async function configureSession(ses: Session, getSettings: () => Settings): Promise<void> {
  // 这一次性决策（权限、密文缓存开关）用当时的取值。订阅层次的选择在会话建立时
  // 就固定了，运行期改不了 —— 见 shared/types.ts 的 RESTART_REQUIRED_SETTINGS。
  //
  // **拼写检查**在设置被改动时会重新写到会话上（见 ipc/index.ts 的 applySettings），因此这里
  // 只是启动时的首次装配。
  //
  // **界面语言**曾经也在这里落（`--lang` + 请求头 + 网页版那条偏好 cookie，[ADR-0063] /
  // [ADR-0065]）。[ADR-0066] 把那一项整个撤掉了：登录之后语言由**账号**决定，我们做的任何固定
  // 都会被页面改回去，于是连 UA 之外的那些会话级语言设置也一并去掉。
  const settings = getSettings()

  // --- 权限 -----------------------------------------------------------------
  // 判据在 `permissions.ts`：**来源 + 类型**双向白名单，不导入 electron，因此单测与离线自检
  // 都能断言"哪些权限被放行"（[ADR-0035]）。这一层只负责把它接到会话上，并在拒绝时留痕 ——
  // 一条 `permission denied` 日志是用户能自己判断"这个功能没反应是不是被我们拒了"的唯一线索。
  ses.setPermissionRequestHandler((contents, permission, callback) => {
    const fromUpstream = isUpstreamOrigin(contents.getURL())
    const allowed = isPermissionAllowed(permission, contents.getURL())

    if (!allowed) {
      logger.warn('permission denied', { permission, fromUpstream })
    }

    callback(allowed)
  })

  // 有些 Web API 只做权限**检查**（不发起请求），因此两个处理器必须用同一套判据 ——
  // 只接一边的症状是"检查通过、请求被拒"或反过来。
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    isPermissionAllowed(permission, requestingOrigin),
  )

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
   * 拼写检查只需要在启动时装配一次：`setSpellCheckerLanguages()` 对已存在的输入框**立即**生效
   * （拼写检查是每一次输入时向内核要素材的，不是页面自己渲染的），因此它不需要重载页面。
   *
   * 紧随其后的订阅补两个窟窿，两个都不会报错（见 `spellcheck.ts` 的 {@link watchSpellcheck}）：
   * 启动时内核**还没给出词典清单**的话，用户勾的那一组就没被交上去；词典**下载失败**时，
   * 除了这里之外没有任何地方能看出来。
   */
  applySpellcheck(ses, settings)
  watchSpellcheck(ses, getSettings, announceDictionaryFailure)

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
