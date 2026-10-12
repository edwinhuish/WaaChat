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
import { attachLangProbeSession } from './dev-probe-lang'
import { registerIpcHandlers } from './ipc'
import { applyLaunchAtLogin } from './integration/login'
import { applyTrayUnread, createTray } from './integration/tray'
import { describeInstanceFailure, instanceId, resolveInstance, sessionPartition } from './instance'
import { chatTargetFromArgv, registerChatProtocol } from './deep-link'
import { applyLinuxGpuSwitches } from './linux-gpu'
import { applySmoothScrolling } from './smooth-scroll'
import { configureLogger, logger, redactPath } from './logger'
import { installApplicationMenu } from './menu'
import { attachDictionaryWatch, configureSession } from './session'
import { getSettings } from './settings'
import { applyDictionaryDownloadSource } from './spellcheck'
import { applyTheme, attachThemeSync } from './theme'
import { attachUnreadTracking } from './unread'
import {
  beginQuit,
  createFilesWindow,
  createMainWindow,
  createSettingsWindow,
  getMainWindow,
  isQuitting,
  openChat,
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
 * `--profile <名>` 选择实例（判据在 `shared/instance.ts`）；不带则是默认实例，此时下面
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
 * 这里**曾经**设过 `--lang`（「界面语言」，[ADR-0063] → [ADR-0065]）。[ADR-0066] 把它撤了。
 *
 * 为什么撤：登录之后网页版的语言由**账号**决定（`WALangPhonePref`，随账号同步下来的手机语言），
 * 页面会在 2–3 秒内把我们写下的任何固定改回去并按账号语言渲染（实测，
 * `docs/research/lang-preference.md` §4.5）。三轮尝试（请求头 → 启动开关 → 页面那条 cookie）
 * 都把可行域摸到了同一个结论：**这件事不在我们这一层**。于是这一项设置、这条开关、以及它连带
 * 的 INV-1 写入例外一起退休 —— 语言交给账号，说明交给设置页里那一行文字。
 *
 * ⚠️ 由它而来的一条**对策仍然生效**：启动期改 locale 会把 Chromium 自己的 locale 一起切走，
 * 而 Electron 的 `role` 菜单项（剪切 / 复制 / 粘贴 / 全选）用的就是它的字符串。现在没人改
 * locale 了，但**系统 locale 照样可能是英文** —— 我们的界面文案必须是中文
 * （`ai/CONVENTIONS.md` 第 1 节），因此 `context-menu.ts` 里那几项仍然必须显式给 label
 * （自检第 19 节断言这一点）。想恢复 `--lang` 时，先读 [ADR-0066] 的"被否决的替代方案"。
 */

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
 * 平滑滚动（[ADR-0081]）。
 *
 * 与上面那一段同类 —— 都是**启动期**决定的内核开关，都必须在 `whenReady` 之前写完
 * （命令行解析之后就固定了）。区别是这一段读的是**用户设置**，因此必须排在
 * `setPath('userData')` 之后：设置文件就在那个目录里，早一步读到的会是另一个实例的。
 *
 * 关掉才写开关："开着"（默认）这一侧一个字节都不动，内核的默认就是它。
 * 用户自己传了这两个开关中的任何一个时这一句是空转（`smooth-scroll.ts` 的边界 1）。
 */
if (applySmoothScrolling(app.commandLine, getSettings().smoothScrolling)) {
  logger.info('smooth scrolling: off (setting), not requesting it from the kernel')
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
app.on('second-instance', (_event, argv) => {
  const window = getMainWindow()
  if (window === null) return

  /**
   * 第二个进程可能是被一个**链接**拉起来的（`xdg-open 'whatsapp://send?phone=…'`、系统的协议
   * 处理器、文件管理器里的"用 WaaChat 打开"）。单实例锁让它把参数转交给我们，于是"从已经运行的
   * 实例里点链接"这条路才走得通（[ADR-0083]）。
   *
   * ⚠️ 必须在 `presentWindow()` **之前**判断：`openChat()` 自己会把窗口调到前台，而"先把窗口
   * 调出来、再换成另一个对话"会让用户看到一次多余的跳转。
   *
   * 没有目标时仍然是老行为：只是把窗口调出来 —— 用户看得见的只有这一步的结果。
   */
  const chatTarget = chatTargetFromArgv(argv)
  if (chatTarget !== null) {
    openChat(window, chatTarget)
    return
  }

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
  /**
   * **第一件事**：把词典下载源写上去，早于**任何**会话被创建（下面 `resolveAccountKey` 那一步
   * 就会碰到承载页面的那个分区会话）。
   *
   * 为什么非这么早不可（实测，[ADR-0072]）：已启用的词典持久化在 profile 的 `Preferences` 里，
   * **会话一被创建**，内核就用那个列表开始取词典 —— 那时 `configureSession()`（以及它里面的
   * `applySpellcheck()`）还没跑，请求于是落到内核默认的 Google CDN。那个源在本网络里会**挂死**
   * （profile 里留下的是 302 到 `*.gvt1-cn.com/edgedl/chrome/dict/…` 的记录），而之后再设一遍
   * 同一个语言列表**什么都不做** —— 于是那一门**永远**下不下来。用户看到的就是"词典一直下载不下来"。
   *
   * 写在默认会话上是因为那个地址是**进程级共享**的（实测：写在哪个会话上都一样），而
   * `session.defaultSession` 是最早能拿到的那个会话。
   */
  applyDictionaryDownloadSource(session.defaultSession)

  const settings = getSettings()

  /**
   * 建分区会话，并且**紧挨着**接上词典事件的订阅（[ADR-0073]）。
   *
   * 这两行中间**不许**出现 `await`。实测（两趟本机探针）：词典已经在磁盘上时，内核在
   * `session.fromPartition()` 之后 **4ms** 就发出了 `spellcheck-dictionary-initialized`，
   * 而那四个事件**不会重发**（把同一个语言列表再设一遍，内核什么都不做，[ADR-0072] 实测）。
   * 订阅原来排在 `configureSession()` 里，前面隔着下面那次读 cookie 的往返（实测约 8ms）
   * —— 晚这几毫秒的代价不是报错，而是设置页上那几格**永远停在空槽**（灰条），而它与"这门
   * 词典本来就不需要下载"长得一模一样：安装版 v1.1.0 的日志里因此一条词典事件都没有。
   */
  const ses = session.fromPartition(sessionPartition())
  attachDictionaryWatch(ses, getSettings)

  /**
   * 账号标识（[ADR-0039]）：归档与密文缓存的第一层目录名，来自分区会话里的 `wa_ul` cookie。
   *
   * 必须早于 `configureSession`：两个接管点都要用它 —— 归档写入（`commitFromTemp`）与
   * 密文缓存的条目路径（`capture/protocol.ts`）。读不到就回落到 `unknown-account`，
   * 不阻断启动。
   */
  await resolveAccountKey(ses)

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
  await configureSession(ses, getSettings)

  /**
   * 开发模式：只读观察网页版那条语言偏好 cookie（未打包时才生效，见 dev-probe-lang.ts）。
   *
   * 我们**不再写它**了（[ADR-0066]），探针留着当耳目：上游哪天开始提供网页端语言开关，或者
   * 改了它怎么写这条 cookie，这是我们唯一能在自己这边看见的窗口。
   *
   * 必须在这里（窗口之前）：要看到页面**第一次**请求的响应头 —— 那一条正是"服务端有没有发
   * `Set-Cookie`"的证据。晚一步就只能从第二次请求看起，而服务端未必要在每一次响应里都写它。
   */
  attachLangProbeSession(session.fromPartition(sessionPartition()))

  // 让系统里的自启条目与设置一致。用户可能在设置里关了自启，或手工删过那个
  // `.desktop` 条目 —— 每次启动对齐一次，代价是一次同步写入。
  applyLaunchAtLogin(settings.launchAtLogin)

  /**
   * 深链接（[ADR-0083]）：告诉系统"`whatsapp:` 归我们"。
   *
   * Linux 上真正建立关联的是安装包里那条 `.desktop` 的 `MimeType=x-scheme-handler/whatsapp;`
   * （electron-builder.yml 的 `linux.desktop.entry`，`pnpm run verify` 断言它在产物里）；
   * 这一行是给 Windows / macOS 与"用户自己指定过默认程序"的情况兜底的，失败只记一条 warn
   * （理由见 main/deep-link.ts）。
   */
  registerChatProtocol()

  /**
   * 主题：**必须在任何窗口被创建之前**（[ADR-0078]）。
   *
   * 窗口的 `backgroundColor` 在构造时就取当前主题的底色，而"跟随系统"时那个值取决于
   * 系统**当时**的深浅 —— 晚一步，启动瞬间的底色就是上一次的答案。
   * 订阅那一条是"系统主题变了"（用户在桌面里切深色）：内核会自己更新我们的界面与内嵌页面，
   * 只有窗口底色需要我们再刷一次。
   */
  applyTheme(settings.theme)
  attachThemeSync()

  // 本地界面：两扇窗口（文件列表 / 设置），各自一个渲染入口，都挂 preload。
  const filesWindow = createFilesWindow()
  const settingsWindow = createSettingsWindow()

  /**
   * 承载上游页面的窗口：**不挂 preload**，见 window.ts 的说明。
   *
   * 深链接（[ADR-0083]）：命令行里带了"要打开哪个对话"时**直接用它开窗口** —— 先开首页再导航
   * 一次会让用户看到首页闪一下。认不出来时 `chatTargetFromArgv()` 已经记过日志，这里照常开首页。
   */
  const mainWindow = createMainWindow(chatTargetFromArgv(process.argv))

  // 开发模式：把只读探针装进这扇窗口的控制台（未打包时才生效，见 dev-probe.ts）。
  attachDevProbe(mainWindow)

  // 右键菜单：唯一的内容是拼写检查的建议（Electron 不像浏览器自带菜单，见 context-menu.ts）。
  attachContextMenu(mainWindow)

  /**
   * 应用菜单：替换 Electron 那份默认菜单（英文、带 DevTools 与 "Learn More about Electron"）。
   *
   * 必须在窗口创建**之后** —— 菜单里那三项要的正是这三扇窗口的引用（与托盘同一批目的地）。
   */
  installApplicationMenu({ files: filesWindow, settings: settingsWindow, main: mainWindow })

  registerIpcHandlers()
  createTray({ files: filesWindow, settings: settingsWindow, main: mainWindow })

  /**
   * 未读徽标（[ADR-0080]）：数据源是**页面标题**（上游把未读数写在那里），由内核交给我们
   * （`page-title-updated`），因此不碰页面一个字节（INV-1）。
   *
   * ⚠️ 必须在 `createTray()` **之后**：这一句会立刻按"当前没有未读"设一次标题与托盘图标，
   * 而托盘还不存在时那次调用只是白跑（`applyTrayUnread` 没有托盘就什么都不做）——
   * 顺序反了不会报错，只会让徽标在启动后的第一次未读数变化之前一直是空的。
   */
  attachUnreadTracking(mainWindow, applyTrayUnread)

  /**
   * `app.getLocale()` 仍然记一条（[ADR-0066] 之后它是**系统** locale，不再由我们设置）。
   *
   * 它有两个用处：内嵌页面在**登录之前**按 `navigator.language` 挑语言，因此它解释了"登录页
   * 为什么是这门语言"；而报告问题时这是第一时间要确认的环境事实之一。
   */
  logger.info('ready', {
    packaged: app.isPackaged,
    chromium: process.versions.chrome,
    electron: process.versions.electron,
    // 两个实例的日志可能被贴进同一份 issue：先写清这一份是谁的。
    instance: instance.id || 'default',
    partition: sessionPartition(),
    locale: app.getLocale(),
  })
})

/**
 * 关闭所有窗口**不**退出应用：应用常驻托盘，这样上游页面的长连接不会断，
 * 通知也能正常到达。真正退出只经由托盘菜单或 Ctrl+Q（会触发 `before-quit`）。
 */
app.on('window-all-closed', () => {
  if (isQuitting()) app.quit()
})
