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
import { isUpstreamPage } from '../shared/upstream'
import { buildUserAgent } from '../shared/user-agent'
import { defaultIconPath, effectiveAppIcon } from './integration/appicon'
import { logger } from './logger'

/** 左上角符合 GNOME 习惯的默认尺寸；上游页面是双栏布局，窄了会很难用。 */
const DEFAULT_SIZE = { width: 1280, height: 820 } as const

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
   * `whatsapp.net` 下的上游自有页（文档预览窗口就在那里）。只放一个源的症状是
   * 预览窗口被拒（主进程日志里的 `ERR_BLOCKED_BY_RESPONSE`），而我们还会把这个
   * 需要登录态的地址交给系统浏览器 —— 那边根本没有登录态。
   */
  window.webContents.setWindowOpenHandler(({ url }) => {
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
 * 本地界面窗口（偏好设置、归档浏览器）。
 *
 * 这是我们自己的内容，因此挂 preload 并通过 IPC 取数据。它加载的是本地文件，
 * 与上游页面共享同一个 session 分区 —— 因此**不要**在这里加载任何远程内容。
 */
export function createLocalWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 680,
    show: false,
    title: 'WaaChat',
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
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  hideOnClose(window)

  localWindow = window
  window.on('closed', () => {
    if (localWindow === window) localWindow = null
  })

  return window
}

/**
 * 我们自己的界面窗口。
 *
 * 存在的理由：主进程有一类消息**只允许**发给它（接管状态推送）。
 * 用 `BrowserWindow.getAllWindows()` 遍历再判断谁"看起来像本地窗口"是不可靠的
 * —— 判断依据会随加载方式（`file://` 还是 dev server）而变化。留一个明确的引用，
 * 判断就只有一处。
 */
let localWindow: BrowserWindow | null = null

export function getLocalWindow(): BrowserWindow | null {
  return localWindow
}

/**
 * 承载上游页面的窗口。
 *
 * 与 {@link getLocalWindow} 对称：`second-instance` 需要的是"把用户的那扇窗口
 * 调出来"，而它是哪一个**不能靠遍历猜** —— `getAllWindows()[0]` 取到的是先创建的
 * 本地窗口（偏好设置），它按设计从不显示，于是"再启动一次应用"看起来毫无反应。
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
