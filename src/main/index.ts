/**
 * 应用入口。
 *
 * 这里只做**装配**：拿设置、配置会话、开窗口、注册 IPC、装托盘。
 * 业务逻辑一律不写在这个文件里 —— 它应该短到能一眼看完。
 */

import { app, dialog, session } from 'electron'

import { APP_ID, DESKTOP_FILE_NAME } from '../shared/constants'
import { isForeignArchiveDir, withInstanceSuffix } from '../shared/instance'
import { resolveAccountKey } from './account'
import { attachContextMenu } from './context-menu'
import { applyArchiveDir, closeArchiveStore } from './archive/store'
import { wipeArchive } from './archive/blobs'
import { attachDevProbe } from './dev-probe'
import { registerIpcHandlers } from './ipc'
import { applyLaunchAtLogin } from './integration/login'
import { createTray } from './integration/tray'
import { describeInstanceFailure, instanceId, resolveInstance, sessionPartition } from './instance'
import { applyLinuxGpuSwitches } from './linux-gpu'
import { configureLogger, logger, redactPath } from './logger'
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
 * 实例解析与"我是哪一份数据"的落点。
 *
 * `--instance <名>` 选择实例（判据在 `shared/instance.ts`）；不带则是默认实例，此时下面
 * 两行写回去的是**原值**，因此既有用户的目录一个字节都不变。
 *
 * 顺序上有三处硬要求，每一处都有具体后果：
 *
 *   1. **必须早于任何读取路径的代码**。`settings.json`、自定义图标、分区存储全在
 *      `userData` 下，晚一步就会读到、写到默认实例的那一份。
 *   2. **必须早于 `app.requestSingleInstanceLock()`**。那把锁是 Chromium 的
 *      `ProcessSingleton`，它把 `SingletonLock` / `SingletonSocket` 放在 **userData 目录里**
 *      —— 因此"每实例一把锁"不是我们另外做的事，而是改完 `userData` 之后**自动成立**的：
 *      两个实例起得来，而同一个实例被启动第二次仍然会把已有窗口叫回来。
 *   3. **必须早于 `whenReady`**：`sessionData` 一旦启动就改不动了（Electron 的明文要求）。
 */
const instance = resolveInstance()

if (instance.error !== null) {
  /**
   * **拒绝启动，而不是回落到默认实例。** 回落会让"我指定的是 work"变成"我动的是默认实例
   * 的数据"，而两种结果在界面上完全一样 —— 用户没有任何办法看出来。
   *
   * 除了 stderr 之外还要弹一个框：这个参数通常写在启动器条目或脚本里，从终端启动的场合很少，
   * 只留一个退出码的话用户看到的是"点了图标没反应"。
   */
  logger.error('instance: invalid instance argument, refusing to start', {
    reason: instance.error,
  })

  try {
    dialog.showErrorBox('WaaChat 无法启动', describeInstanceFailure(instance))
  } catch {
    // 没有可用显示（headless）时弹不出来，这时 stderr 与退出码就是全部线索。
  }

  process.exit(1)
}

const userDataDir = app.getPath('userData')
const sessionDataDir = app.getPath('sessionData')

app.setPath('userData', withInstanceSuffix(userDataDir, instance.id))
app.setPath('sessionData', withInstanceSuffix(sessionDataDir, instance.id))

/**
 * 界面语言：决定 `navigator.language` 的那个开关（[ADR-0063]）。
 *
 * ⚠️ 它**只能在这里设**，而且必须早于 `whenReady` —— `--lang` 是 Chromium 的启动期开关，
 * 运行期改不了。因此「界面语言」是**重启后生效**的（`RESTART_REQUIRED_SETTINGS`），
 * 设置页也这么写。
 *
 * 为什么非它不可：网页版是纯 JS 应用，按 `navigator.language` 挑自己的语言包，而那个值来自
 * **应用 locale**。实测（Electron 44.7）只设会话的 `Accept-Language` **完全改不动**它 ——
 * 那个头只影响网络层，`navigator.language` 始终是系统的 `zh-CN`。会话级的
 * `setUserAgent(ua, acceptLanguages)` 仍然保留：它负责请求头里的**有序回退**，两件事互不替代。
 *
 * ⚠️ 副作用要照看：这一步会把 Chromium 自己的 locale 一起切过去（`app.getLocale()` 实测从
 * `zh-CN` 变成 `en-US`），而 Electron 的 `role` 菜单项（剪切 / 复制 / 粘贴 / 全选）用的是**它的**
 * 字符串。我们自己的界面文案必须是中文（`ai/CONVENTIONS.md` 第 1 节），因此那几项在
 * `context-menu.ts` 里显式给了 label —— 改这里时别忘了那一边。
 */
app.commandLine.appendSwitch('lang', getSettings().uiLanguage)

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
 * 单实例锁 —— **每实例一把**。
 *
 * 两个进程争抢同一个会话分区里的登录态，症状是随机出现需要重新扫码，因此这把锁必须留着。
 * 但它的粒度已经不是"整台机器"：Chromium 的 `ProcessSingleton` 把锁文件放在 **userData
 * 目录里**，而 userData 上面刚刚按实例改写过了 —— 于是"锁住同一份数据"这件事自动变成了
 * "锁住同一个实例"，不同实例互不相干（这正是它们的隔离所必需的）。
 *
 * 因此下面这条注释的**语义已经变了**：它不是"全机只有一个 WaaChat"，而是"这个实例只有
 * 一个进程"。`second-instance` 收到的也是**同一实例**的第二次启动。
 *
 * 必须在 `whenReady` **之前**申请，且必须在 `setPath('userData')` **之后**。
 */
if (!app.requestSingleInstanceLock()) {
  logger.info('this instance is already running, exiting', { instance: instance.id || 'default' })
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
  await resolveAccountKey(session.fromPartition(sessionPartition()))

  /**
   * 归档位置必须早于会话配置：接管点 A 在装配时就会建好归档目录并清扫临时文件，
   * 晚一步它就会把目录建到**默认**位置上，而用户设置的是别的地方。
   */
  const archiveDirNow = applyArchiveDir(settings.archiveDir)

  /**
   * 用户把归档指到**另一个实例**的归档根上了吗？
   *
   * 这里只**说**，不改：把配置指向别处是他自己的决定，而"拒绝使用 + 退回到默认位置"会让他
   * 看到一份空归档 —— 那比共享一个目录更糟。共享的真实后果是"退出时清除归档"会删掉对方
   * 的文件（两棵树一起被清），因此至少要有这一条日志与 `docs/usage.md` 的注意事项。
   */
  if (isForeignArchiveDir(archiveDirNow, instanceId())) {
    logger.warn('instance: the archive directory looks like another instance’s', {
      dir: redactPath(archiveDirNow),
      instance: instance.id || 'default',
    })
  }

  // 会话配置必须早于创建任何窗口：两个接管点都是挂在 session 上的。
  // 传读取函数而不是快照 —— 见 settings.ts 里 current 的说明。
  await configureSession(session.fromPartition(sessionPartition()), getSettings)

  // 让系统里的自启条目与设置一致。用户可能在设置里关了自启，或手工删过那个
  // `.desktop` 条目 —— 每次启动对齐一次，代价是一次同步写入。
  applyLaunchAtLogin(settings.launchAtLogin)

  // 本地界面：两扇窗口（文件列表 / 设置），各自一个渲染入口，都挂 preload。
  const filesWindow = createFilesWindow()
  const settingsWindow = createSettingsWindow()

  // 承载上游页面的窗口：**不挂 preload**，见 window.ts 的说明。
  const mainWindow = createMainWindow()

  // 开发模式：把只读探针装进这扇窗口的控制台（未打包时才生效，见 dev-probe.ts）。
  attachDevProbe(mainWindow)

  // 右键菜单：唯一的内容是拼写检查的建议（Electron 不像浏览器自带菜单，见 context-menu.ts）。
  attachContextMenu(mainWindow)

  registerIpcHandlers()
  createTray({ files: filesWindow, settings: settingsWindow, main: mainWindow })

  logger.info('ready', {
    packaged: app.isPackaged,
    chromium: process.versions.chrome,
    electron: process.versions.electron,
    // 两个实例的日志可能被贴进同一份 issue：先写清这一份是谁的。
    instance: instance.id || 'default',
    partition: sessionPartition(),
  })
})

/**
 * 关闭所有窗口**不**退出应用：应用常驻托盘，这样上游页面的长连接不会断，
 * 通知也能正常到达。真正退出只经由托盘菜单或 Ctrl+Q（会触发 `before-quit`）。
 */
app.on('window-all-closed', () => {
  if (isQuitting()) app.quit()
})
