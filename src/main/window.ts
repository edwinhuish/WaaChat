/**
 * 窗口。
 *
 * 这里有本项目最重要的一个结构性决定：
 *
 *   承载上游页面的窗口 **不挂 preload**。
 *
 * 因为 [INV-1] 禁止注入，preload 本就不该与页面交互；而只要它不存在，
 * "远程内容触达本地能力"（docs/security.md T1）在**结构上**就不可能发生 ——
 * 不需要靠代码正确性来保证。审查时不需要逐行读 preload，只要确认这类窗口
 * 的 webPreferences 里没有 preload 即可。
 *
 * 只有我们自己的本地界面窗口才挂 preload。
 */

import { join } from 'node:path'

import { BrowserWindow, app, shell } from 'electron'

import { SESSION_PARTITION, UPSTREAM_URL } from '../shared/constants'
import { isDocumentPreviewPage, isUpstreamPage } from '../shared/upstream'
import { buildUserAgent } from '../shared/user-agent'
import { defaultIconPath, effectiveAppIcon } from './integration/appicon'
import { logger } from './logger'

/** 左上角符合 GNOME 习惯的默认尺寸；上游页面是双栏布局，窄了会很难用。 */
const DEFAULT_SIZE = { width: 1280, height: 820 } as const

/**
 * 本地界面窗口的尺寸。
 *
 * 两扇窗口（文件列表 / 设置）共用它：一个是列表、一个是表单，都不需要聊天窗口那么宽。
 * 定义一个常量而不是各写一份，是为了让"两扇同类窗口"这件事在代码里看得出来。
 */
const LOCAL_WINDOW_SIZE = { width: 960, height: 680 } as const

/**
 * 本地界面的渲染入口（各自的 HTML 文件名）。
 *
 * 一扇窗口一个入口（[ADR-0025]）：构建配置里两个都要显式声明，漏掉一个只会在运行期
 * 白屏，因此产物冒烟测试对两个 HTML 都断言存在。
 */
const FILES_ENTRY = 'files.html'
const SETTINGS_ENTRY = 'settings.html'

/**
 * "正在退出"。
 *
 * 「关闭窗口 = 隐藏」这条约定必须给真正的退出让路，否则退出会**静默失效**：
 * `app.quit()` 的实现方式是逐个关闭窗口，而 Electron 把"某个窗口的 close 被
 * preventDefault"整体判定为"这次退出被取消"（`will-quit` 也不会发出），
 * 并且会把这个状态清掉。于是托盘的「退出」只在日志里留下一条 before-quit，
 * 应用继续活着 —— 而窗口一个都没少，用户看不到任何反馈。
 *
 * 所以退出路径必须**先**调用 {@link beginQuit}：目前只有 index.ts 的
 * `before-quit` 一处，这样 Ctrl+Q、托盘菜单、SIGTERM 都覆盖到。
 */
let quitting = false

export function beginQuit(): void {
  quitting = true
}

/** 退出是否已经开始。`window-all-closed` 用它区分"关掉窗口"与"退出应用"。 */
export function isQuitting(): boolean {
  return quitting
}

/** 关闭窗口时隐藏而非销毁 —— 见 index.ts 的 window-all-closed 说明。 */
function hideOnClose(window: BrowserWindow): void {
  window.on('close', (event) => {
    if (quitting) return
    if (app.isPackaged === false) return
    event.preventDefault()
    window.hide()
  })
}

/**
 * 承载上游页面的窗口。
 *
 * 注意 webPreferences 的每一项都不是随手写的：
 *  - 没有 `preload`         → 远程内容无法触达本地能力（结构保证，不是约定）
 *  - `contextIsolation: true` → 即使将来有人误加 preload，也不会与页面共享上下文
 *  - `sandbox: true`        → 渲染进程在受限沙箱中运行
 *  - `nodeIntegration: false` → 页面拿不到 Node
 *  - `partition`            → 登录态持久化；改了它等于让所有用户重新扫码
 *
 * `icon` 只在 **X11** 下决定窗口图标（`_NET_WM_ICON`）；Wayland 下由合成器按 `app_id`
 * 从 `.desktop` 取，这里的值会被忽略。改动自定义图标要同时照顾这两条路，见 ADR-0022。
 */
export function createMainWindow(): BrowserWindow {
  const userAgent = buildUserAgent(process.versions.chrome)

  const window = new BrowserWindow({
    ...DEFAULT_SIZE,
    show: false,
    title: 'WaaChat',
    autoHideMenuBar: true,
    icon: effectiveAppIcon() ?? defaultIconPath(),
    webPreferences: {
      partition: SESSION_PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // 刻意不设置 preload。
    },
  })

  /**
   * UA 必须在创建 webContents 之后、加载之前设置。Electron 会把
   * `Electron/x.y.z` 写进默认 UA，上游可能据此判定浏览器不受支持。
   * 构造逻辑见 shared/user-agent.ts（纯函数，有单测）。
   */
  window.webContents.setUserAgent(userAgent)

  /**
   * 链接处理：上游站内的链接留在应用内，站外的交给系统浏览器。
   * 不这样做的话，点一个外部链接会把当前页面导航走 —— 而那个页面承载着登录态。
   *
   * "站内"的判据见 shared/upstream.ts：**不只** `web.whatsapp.com`，还包括
   * `whatsapp.net` 下的上游自有页。只放一个源的症状是那些页面被拒（主进程日志里的
   * `ERR_BLOCKED_BY_RESPONSE`），而我们还会把这个需要登录态的地址交给系统浏览器 ——
   * 那边根本没有登录态。
   *
   * **例外是文档预览页**：它的唯一作用是把 PDF 交给内核的**内置阅读器**渲染，而本应用要的
   * 是"文件交给系统应用打开"（[ADR-0029]）。因此**拒绝**它 —— 并且**不**交给系统浏览器：
   * 同一个理由，那个地址需要登录态，在别处打开只会得到一个打不开的页面。
   *
   * 子框架那一层（预览被嵌进 `web.whatsapp.com` 的 iframe 时）由 `capture/pdf.ts` 的
   * 请求拦截负责，窗口处理看不到它。
   */
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isDocumentPreviewPage(url)) {
      logger.warn('window: blocked the upstream document preview window')
      return { action: 'deny' }
    }

    if (isUpstreamPage(url)) {
      return { action: 'allow' }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.once('ready-to-show', () => window.show())

  hideOnClose(window)

  mainWindow = window
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  void window.loadURL(UPSTREAM_URL)

  logger.info('main window created', { userAgentClean: !userAgent.includes('Electron') })

  return window
}

/**
 * 开发模式下把入口拼到 Vite dev server 上。
 *
 * 末尾的斜杠必须补上：`new URL('files.html', 'http://host:5173')` 会把最后一段路径
 * 当成文件名丢掉（`http://host:5173/files.html` 是巧合对了，一旦 dev server URL 带
 * 路径段就会拼错）。
 */
function devEntryUrl(devServerUrl: string, entry: string): string {
  const base = devServerUrl.endsWith('/') ? devServerUrl : `${devServerUrl}/`
  return new URL(entry, base).toString()
}

/**
 * 本地界面窗口的公共构造。
 *
 * 这是我们自己的内容，因此挂 preload 并通过 IPC 取数据。它加载的是本地文件，
 * 与上游页面共享同一个 session 分区 —— 因此**不要**在这里加载任何远程内容。
 *
 * 关闭窗口 = 隐藏（{@link hideOnClose}）：应用常驻托盘，两扇窗口随时可以再打开。
 */
function createLocalWindow(options: {
  readonly title: string
  readonly entry: string
}): BrowserWindow {
  const window = new BrowserWindow({
    ...LOCAL_WINDOW_SIZE,
    show: false,
    title: options.title,
    autoHideMenuBar: true,
    icon: effectiveAppIcon() ?? defaultIconPath(),
    webPreferences: {
      partition: SESSION_PARTITION,
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (app.isPackaged === false && devServerUrl !== undefined) {
    void window.loadURL(devEntryUrl(devServerUrl, options.entry))
  } else {
    void window.loadFile(join(__dirname, `../renderer/${options.entry}`))
  }

  hideOnClose(window)

  return window
}

/**
 * 文件列表窗口：归档里的文件（前身是「归档」标签页）。
 *
 * ⚠️ "归档"是**数据层**的概念（内容寻址的库、索引、迁移，见 [ADR-0018]），
 * "文件列表"是这扇**窗口**的名字 —— 两者不要混用（[ADR-0025] 理由 3）。
 */
export function createFilesWindow(): BrowserWindow {
  const window = createLocalWindow({ title: 'WaaChat — 文件列表', entry: FILES_ENTRY })

  filesWindow = window
  window.on('closed', () => {
    if (filesWindow === window) filesWindow = null
  })

  return window
}

/**
 * 设置窗口：偏好设置 + 接管状态。
 *
 * 接管状态标签只挂在这一扇窗口里（[ADR-0025] 理由 5）：它与设置项同属"应用当前的
 * 行为是什么"。因此 `capture:health-changed` 的推送目标只有这一个。
 */
export function createSettingsWindow(): BrowserWindow {
  const window = createLocalWindow({ title: 'WaaChat — 设置', entry: SETTINGS_ENTRY })

  settingsWindow = window
  window.on('closed', () => {
    if (settingsWindow === window) settingsWindow = null
  })

  return window
}

/**
 * 我们自己的界面窗口（两扇，见 [ADR-0025]）。
 *
 * 存在的理由：主进程有两类消息**只允许**发给自己人（接管状态推送、迁移进度），
 * 而对话框需要一个父窗口。用 `BrowserWindow.getAllWindows()` 遍历再判断谁"看起来像
 * 本地窗口"是不可靠的 —— 判断依据会随加载方式（`file://` 还是 dev server）而变化。
 * 留明确的引用，"是哪一扇"就只有一个答案。
 */
let filesWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null

/** 文件列表窗口。托盘入口与"打开归档"这类动作指的是它。 */
export function getFilesWindow(): BrowserWindow | null {
  return filesWindow
}

/**
 * 设置窗口。
 *
 * 迁移确认框、目录/图标选择框都挂在它上面（那些操作全部由设置项发起），
 * 迁移进度也只推给它（进度行长在设置页里）。
 */
export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow
}

/**
 * 承载上游页面的窗口。
 *
 * 与两个本地窗口的 getter 对称：`second-instance` 需要的是"把用户的那扇窗口调出来"，
 * 而它是哪一个**不能靠遍历猜** —— `getAllWindows()[0]` 取到的可能是先创建的本地窗口，
 * 它按设计从不显示，于是"再启动一次应用"看起来毫无反应。
 */
let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/**
 * 把一扇窗口带到用户面前。
 *
 * 隐藏（关闭到托盘）与最小化是两种不同状态，`show()` 只解前一种，因此两步都要做。
 *
 * ⚠️ 在 Wayland 下 `focus()` 只是"请求焦点"：合成器可以拒绝（防抢焦点），窗口会留在
 * 原地。这是平台行为，不是这里的缺陷 —— 不要为了"一定到前台"去加置顶之类的开关。
 */
export function presentWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
