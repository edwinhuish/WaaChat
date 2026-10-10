/**
 * 应用入口。
 *
 * 这里只做**装配**：拿设置、配置会话、开窗口、注册 IPC、装托盘。
 * 业务逻辑一律不写在这个文件里 —— 它应该短到能一眼看完。
 */

import { app, session } from 'electron'

import { APP_ID, DESKTOP_FILE_NAME, SESSION_PARTITION } from '../shared/constants'
import { resolveAccountKey } from './account'
import { applyArchiveDir, closeArchiveStore } from './archive/store'
import { wipeArchive } from './archive/blobs'
import { registerIpcHandlers } from './ipc'
import { applyLaunchAtLogin } from './integration/login'
import { createTray } from './integration/tray'
import { applyLinuxGpuSwitches } from './linux-gpu'
import { configureLogger, logger } from './logger'
import { configureSession } from './session'
import { getSettings } from './settings'
import {
  beginQuit,
  createFilesWindow,
  createMainWindow,
  createSettingsWindow,
  getMainWindow,
  isQuitting,
  presentWindow,
} from './window'

/**
 * 注入"是否打包"。必须早于**任何一条**日志 —— 否则那几条会按默认级别
 * （debug）输出，打包后依然如此，症状是用户日志里混进开发噪音。
 *
 * logger 刻意不自己 import electron（理由见 logger.ts），因此这一步是必须的装配。
 */
configureLogger({ packaged: app.isPackaged })

/**
 * Linux：**Wayland 的臭氧路径没有 Vulkan surface**。Chromium 里有一条默认开启的
 * 「WebGPU 在原生 Vulkan 上 + GL 互操作」的路，每次启动都会去建一个原生 Vulkan 实现，
 * 于是留下一行 `wayland_surface_factory.cc … not compatible with Vulkan` 的 ERROR。
 * 这里在**最早**的时刻决定"在这个平台上不请求它"。
 *
 * 必须在 `whenReady` 之前、GPU 进程启动之前。判据与四条边界（只在 Wayland 动、不覆盖用户的
 * `--disable-features`、用户显式要求 Vulkan 或自己指定了 WebGPU 后端时不动）见 `linux-gpu.ts`
 * 与 [ADR-0036] / [ADR-0038]。
 */
if (process.platform === 'linux') {
  const changed = applyLinuxGpuSwitches(app.commandLine, {
    sessionType: process.env['XDG_SESSION_TYPE'],
    waylandDisplay: process.env['WAYLAND_DISPLAY'],
  })

  if (changed) {
    logger.info('linux: not requesting Vulkan (the Wayland ozone path has no Vulkan surfaces)')
  }
}

/**
 * 单实例锁。
 *
 * 两个实例会争抢同一个会话分区（`persist:waachat`）里的登录态，症状是随机出现
 * 需要重新扫码。必须在 `whenReady` **之前**申请。
 */
if (!app.requestSingleInstanceLock()) {
  logger.info('another instance is already running, exiting')
  process.exit(0)
}

/**
 * 声明桌面条目。
 *
 * 这一行与 package.json 的 `desktopName`、electron-builder.yml 的
 * `StartupWMClass` 构成三处一致的身份声明。缺了它，GNOME / Wayland 拿不到
 * app_id，Dock 上会显示通用占位图标，且启动器图标与运行窗口不会合并。
 *
 * 必须在 `whenReady` 之前调用。
 */
app.setDesktopName(DESKTOP_FILE_NAME)

/** 与 appId 保持一致，便于日志与崩溃报告关联。 */
app.setAppUserModelId(APP_ID)

/**
 * 再次启动应用（Dock 图标、启动器、`waachat` 命令）时，把**已有**的那扇
 * 窗口调出来 —— 单实例锁的另一个实例已经退出了，用户能看到的只有这一步的结果。
 *
 * 必须点名主窗口而不是 `getAllWindows()[0]`：后者是先创建的本地窗口（偏好设置），
 * 它按设计从不显示，于是这一步会变成"毫无反应"。见 window.ts 的 getMainWindow。
 *
 * 允许此时窗口还不存在（第二个实例可能比 `whenReady` 更早到达）—— 那就什么都不做，
 * 反正主窗口正在创建的路上。
 */
app.on('second-instance', () => {
  const window = getMainWindow()
  if (window === null) return
  presentWindow(window)
})

app.on('before-quit', () => {
  /**
   * 先解除"关闭窗口 = 隐藏"的拦截，否则这次退出会被它取消（见 window.ts 的
   * beginQuit）。这必须是 before-quit 的第一件事 —— 后续任何一步抛错都不能
   * 让它被跳过。
   */
  beginQuit()

  /**
   * 退出清理。
   *
   * ⚠️ **只清归档**。登录态在 Electron 的会话分区里，与归档物理分离
   * （[ADR-0008]），因此这里不存在"顺手把 session 也删了"的可能 —— 那是不可从
   * 错误中恢复的后果（用户得重新扫码）。
   */
  if (getSettings().wipeArchiveOnExit) {
    /**
     * 归档索引就在归档目录里（[ADR-0018]），所以删之前必须先断开它 ——
     * 否则 WAL 会把刚被删掉的 `.index.sqlite` 重新写回来，留下一个"文件没了、
     * 索引还在"的空库。
     */
    closeArchiveStore()

    const removed = wipeArchive()
    logger.info('archive wiped on exit', { entries: removed })
  }
})

/** 连接关闭放在 `will-quit`：`before-quit` 之后可能还有窗口在收尾。 */
app.on('will-quit', () => {
  closeArchiveStore()
})

app.whenReady().then(async () => {
  const settings = getSettings()

  /**
   * 账号标识（[ADR-0039]）：归档与密文缓存的第一层目录名，来自分区会话里的 `wa_ul` cookie。
   *
   * 必须早于 `configureSession`：两个接管点都要用它 —— 归档写入（`commitFromTemp`）与
   * 密文缓存的条目路径（`capture/protocol.ts`）。读不到就回落到 `unknown-account`，
   * 不阻断启动。
   */
  await resolveAccountKey(session.fromPartition(SESSION_PARTITION))

  /**
   * 归档位置必须早于会话配置：接管点 A 在装配时就会建好归档目录并清扫临时文件，
   * 晚一步它就会把目录建到**默认**位置上，而用户设置的是别的地方。
   */
  applyArchiveDir(settings.archiveDir)

  // 会话配置必须早于创建任何窗口：两个接管点都是挂在 session 上的。
  // 传读取函数而不是快照 —— 见 settings.ts 里 current 的说明。
  await configureSession(session.fromPartition(SESSION_PARTITION), getSettings)

  // 让系统里的自启条目与设置一致。用户可能在设置里关了自启，或手工删过那个
  // `.desktop` 条目 —— 每次启动对齐一次，代价是一次同步写入。
  applyLaunchAtLogin(settings.launchAtLogin)

  // 本地界面：两扇窗口（文件列表 / 设置），各自一个渲染入口，都挂 preload。
  const filesWindow = createFilesWindow()
  const settingsWindow = createSettingsWindow()

  // 承载上游页面的窗口：**不挂 preload**，见 window.ts 的说明。
  const mainWindow = createMainWindow()

  registerIpcHandlers()
  createTray({ files: filesWindow, settings: settingsWindow, main: mainWindow })

  logger.info('ready', {
    packaged: app.isPackaged,
    chromium: process.versions.chrome,
    electron: process.versions.electron,
  })
})

/**
 * 关闭所有窗口**不**退出应用：应用常驻托盘，这样上游页面的长连接不会断，
 * 通知也能正常到达。真正退出只经由托盘菜单或 Ctrl+Q（会触发 `before-quit`）。
 */
app.on('window-all-closed', () => {
  if (isQuitting()) app.quit()
})
