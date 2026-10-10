/**
 * 应用图标：读、写、应用，以及启动器条目的覆盖。
 *
 * 为什么值得一个独立模块，而不是塞进 tray.ts 或 window.ts：
 *
 *  1. **图标有三个落点，生效时机互不相同**（见 ADR-0022）—— 窗口（`setIcon`：X11 立即、
 *     Wayland 无效）、托盘（`setImage`：立即）、启动器 / Dock（`.desktop` 的 `Icon=`：
 *     要等桌面刷新）。三处必须由同一个来源驱动，否则会出现"托盘换了、窗口没换"这类半截状态。
 *  2. **写入必须原子**。图标文件被写坏的症状是"下次启动图标变回默认值"，而且不报错。
 *  3. **失败要能整体回滚**。写启动器条目失败时必须把图标文件恢复原样 —— 否则用户得到的是
 *     "窗口图标换了、启动器没换"这种无法解释的状态（同 ADR-0019 的取舍：要么全成，要么全不成）。
 *
 * 本模块**不导入** `window.ts` / `tray.ts`：它只操作 `BrowserWindow.getAllWindows()`，
 * 托盘的刷新由调用方（`ipc/index.ts`）负责。这样 window → appicon → tray → window
 * 的循环依赖就不存在了。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { BrowserWindow, app, nativeImage } from 'electron'
import type { NativeImage } from 'electron'

import {
  APP_ICON_SIZE,
  CUSTOM_ICON_FILENAME,
  DESKTOP_ENTRY_MARKER,
  MAX_SOURCE_ICON_BYTES,
  MAX_SUBMITTED_ICON_BYTES,
  buildDesktopEntry,
  iconExtension,
  isAcceptedIconName,
} from '../../shared/appicon'
import { APP_DISPLAY_NAME, APP_ID, DESKTOP_FILE_NAME } from '../../shared/constants'
import { formatBytes } from '../../shared/format'
import type { AppIconPickResult, AppIconResult, AppIconState } from '../../shared/types'
import { usingDefaultInstance } from '../instance'
import { logger } from '../logger'

/**
 * 默认图标的路径。
 *
 * 打包后来自 `extraResources`（见 electron-builder.yml）；开发模式下直接读仓库里的
 * `build/icon.png`。不能指望它出现在 `out/` 里 —— 那里只有编译产物。
 */
export function defaultIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
}

/**
 * 自定义图标的落点。
 *
 * **它存在与否就是"是否启用自定义图标"的事实源**，不额外写进 `settings.json`：
 * 那样会出现"设置说启用了、文件却不在"的分裂状态，而图标没有第二个消费者。
 */
export function customIconPath(): string {
  return join(app.getPath('userData'), CUSTOM_ICON_FILENAME)
}

/**
 * 用户级桌面条目的路径。
 *
 * 放在 `~/.local/share/applications/` 而不是系统目录，理由是它**本就是"用户覆盖"这个机制**：
 * 与 deb 装到 `/usr/share/applications/` 的那份同名，按 XDG 的查找顺序优先生效。
 * 因此既不需要 root，卸载时系统那份也仍然完好。
 */
export function desktopEntryPath(): string {
  const dataHome = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return join(dataHome, 'applications', DESKTOP_FILE_NAME)
}

/** 已加载的自定义图标。`undefined` 表示"还没读过"。 */
let cachedCustom: NativeImage | null | undefined
/** 默认图标读一次就够，不必每次刷新界面都碰一次磁盘。 */
let cachedDefault: NativeImage | null | undefined

/** 换过图标之后必须清缓存，否则窗口上贴的还是旧的那张。 */
function invalidate(): void {
  cachedCustom = undefined
}

function loadCustomIcon(): NativeImage | null {
  const path = customIconPath()
  if (!existsSync(path)) return null

  const image = nativeImage.createFromPath(path)
  if (!image.isEmpty()) return image

  /**
   * 文件在、但读不出来（被写坏、被别的程序截断）。此时**删掉它**并回到默认图标：
   * 留着一个读不出的文件，下次启动还会在同一个地方摔倒；而日志里必须留痕，
   * 否则用户报"我的图标设置丢了"时无从解释。
   */
  logger.warn('appicon: custom icon is unreadable, falling back to the default icon')
  removeIfPresent(path)
  return null
}

function defaultAppIcon(): NativeImage | null {
  if (cachedDefault === undefined) {
    const image = nativeImage.createFromPath(defaultIconPath())
    cachedDefault = image.isEmpty() ? null : image
  }
  return cachedDefault
}

/**
 * 当前生效的图标：自定义优先，否则默认。两者都拿不到时返回 `null`。
 *
 * 调用方拿到 `null` 应当**跳过**贴图而不是贴一张空图 —— 空图会让窗口图标真的变成空白。
 */
export function effectiveAppIcon(): NativeImage | null {
  if (cachedCustom === undefined) cachedCustom = loadCustomIcon()
  return cachedCustom ?? defaultAppIcon()
}

/**
 * 把图标贴到所有窗口上。
 *
 * ⚠️ `BrowserWindow.setIcon()` 在 **Wayland 下无效**：窗口图标由合成器按 `app_id` 从
 * `.desktop` 取，应用无权改。X11 下它改的是 `_NET_WM_ICON`，立即生效。
 * 这是平台行为，不是这里的缺陷 —— 界面文案必须如实说明（见 docs/usage.md）。
 */
export function applyAppIconToWindows(): void {
  const image = effectiveAppIcon()
  if (image === null) return

  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.setIcon(image)
  }
}

// ---------------------------------------------------------------------------
// 用户级桌面条目
// ---------------------------------------------------------------------------

/**
 * 目标条目是不是**我们**写的。
 *
 * 判据是标记行，不是"文件存在"。用户完全可能自己写一份同名条目来调启动器参数 ——
 * 那不是我们的东西，不该被我们改掉或删掉。
 */
function isManagedDesktopEntry(): boolean {
  const path = desktopEntryPath()
  if (!existsSync(path)) return false

  try {
    return readFileSync(path, 'utf8').includes(DESKTOP_ENTRY_MARKER)
  } catch {
    // 读不出来就当它不是我们的：宁可不动，也不要覆盖一个读不到的文件。
    return false
  }
}

/** 存在但不是我们写的 → 返回它的路径（用于失败详情）；否则返回 `null`。 */
function desktopEntryConflict(): string | null {
  const path = desktopEntryPath()
  if (!existsSync(path)) return null
  return isManagedDesktopEntry() ? null : DESKTOP_FILE_NAME
}

/**
 * 写用户级桌面条目，让启动器 / Dock 用上自定义图标。
 *
 * **开发模式下跳过**：那时 `Exec` 只能指向 `node_modules` 里的 Electron，
 * 写进启动器只会多出一个点不开的图标（同 `integration/login.ts` 的判断）。
 *
 * **命名实例也跳过**（多实例，[ADR-0062]）：这份条目描述的是**这个应用**，路径与 app_id
 * 都是全机唯一的一份（`~/.local/share/applications/<app_id>.desktop`）。两个实例都写它，
 * 结果是互相覆写 —— 而"改完图标只有一半生效"没有任何报错能解释。归属交给默认实例。
 *
 * 命名实例的自定义图标**仍然生效**，只是作用范围是它自己的窗口与托盘（那两处本来就是
 * 每进程一份的）。
 */
function writeDesktopEntry(iconPath: string): void {
  if (!app.isPackaged) return

  if (!usingDefaultInstance()) {
    logger.info('appicon: the launcher entry belongs to the default instance, skipping')
    return
  }

  const path = desktopEntryPath()
  mkdirSync(dirname(path), { recursive: true })

  writeFileSync(
    path,
    buildDesktopEntry({
      // 与窗口标题的**基名**同源，必须等于 electron-builder.yml 的 productName。
      // 注意这里**不带**实例后缀：条目说的是这个应用，不是某个实例（见上面的说明）。
      name: APP_DISPLAY_NAME,
      /**
       * AppImage 下真正该被执行的是 `.AppImage` 文件本身，而不是挂载点里的那个可执行文件 ——
       * 挂载点每次启动都不同（同 integration/login.ts 里的路径陷阱）。
       */
      exec: process.env['APPIMAGE'] ?? process.execPath,
      iconPath,
      startupWMClass: APP_ID,
    }),
    { mode: 0o644 },
  )
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

/**
 * 原子写：先写临时名，再 `rename` 过去。
 *
 * 直接覆写的风险是"读到半截文件" —— 图标文件正好会被**下次启动**读到，
 * 而半截的 PNG 在 `nativeImage` 那里只是"解不出来"，于是静默退回默认图标。
 */
function writeAtomically(path: string, data: Buffer | string, mode: number): void {
  const temporary = `${path}.part-icon`
  writeFileSync(temporary, data, { mode })
  renameSync(temporary, path)
}

function removeIfPresent(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch (error) {
    logger.warn('appicon: failed to remove a file', { reason: (error as Error).name })
  }
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

function dataUrlOf(image: NativeImage | null): string | null {
  if (image === null) return null
  return `data:image/png;base64,${image.toPNG().toString('base64')}`
}

/**
 * 界面要的全部状态。
 *
 * 这里**重新看一眼磁盘**而不是直接用缓存：文件在不在就是那个开关本身，而它可能被外部
 * 删掉或替换（用户清理目录、同步工具插手）。顺手也会把读不出来的文件清掉（`loadCustomIcon`），
 * 于是界面下一次刷新就会如实显示"默认图标"。
 */
export function appIconState(): AppIconState {
  cachedCustom = loadCustomIcon()

  const custom = cachedCustom !== null

  return {
    custom,
    updatedAt: custom ? mtimeOf(customIconPath()) : null,
    desktopEntry: isManagedDesktopEntry(),
    preview: dataUrlOf(cachedCustom ?? defaultAppIcon()),
  }
}

/**
 * 读用户选中的源文件。
 *
 * **只返回字节，不返回路径**（`ai/INVARIANTS.md` G-1）：路径是能力，字节只是数据。
 *
 * 上限判断先于读取：把一个 2 GB 的文件读进内存、只为让解码器拒绝它，代价太大。
 */
export function readIconSource(path: string, name: string): AppIconPickResult {
  if (!isAcceptedIconName(name)) {
    return { ok: false, failure: 'unsupported-format', detail: iconExtension(name) || name }
  }

  let size: number
  try {
    size = statSync(path).size
  } catch {
    return { ok: false, failure: 'unreadable', detail: name }
  }

  if (size > MAX_SOURCE_ICON_BYTES) {
    return { ok: false, failure: 'too-large', detail: formatBytes(size) }
  }

  try {
    return { ok: true, name, bytes: readFileSync(path) }
  } catch {
    return { ok: false, failure: 'unreadable', detail: name }
  }
}

/** 把图标文件恢复成写之前的样子。`null` 表示原本就没有它。 */
function restoreIconFile(path: string, previous: Buffer | null): void {
  try {
    if (previous === null) rmSync(path, { force: true })
    else writeAtomically(path, previous, 0o600)
  } catch (error) {
    // 回滚失败是"需要人工核对"的一类：日志里必须留下痕迹，界面上的失败文案也已足够具体。
    logger.warn('appicon: rollback of the icon file failed', { reason: (error as Error).name })
  }
}

/**
 * 落盘并启用一张已经裁剪好的 PNG。
 *
 * 顺序是刻意的 —— **所有可能失败的判断都排在动任何东西之前**：
 * 校验 → 冲突检查 → 写图标 → 写启动器条目。最后一步失败时回滚前一步，
 * 于是"失败"与"什么都没变"是等价的（用户的要求：失败时保留原图标）。
 */
export function setAppIcon(png: Uint8Array): AppIconResult {
  const bytes = Buffer.from(png)

  if (bytes.length === 0) {
    return { ok: false, failure: 'invalid-image', detail: '没有收到数据' }
  }
  if (bytes.length > MAX_SUBMITTED_ICON_BYTES) {
    return { ok: false, failure: 'invalid-image', detail: `回传了 ${formatBytes(bytes.length)}` }
  }

  /**
   * 主进程自己再解一次。渲染进程是可信的**代码**，但它送进来的是**数据** ——
   * 这里用一个真实的解码器确认它确实是一张图，顺便拿到尺寸。
   */
  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) {
    return { ok: false, failure: 'invalid-image', detail: '不是可解码的 PNG' }
  }

  const { width, height } = image.getSize()
  if (width !== APP_ICON_SIZE || height !== APP_ICON_SIZE) {
    return {
      ok: false,
      failure: 'invalid-image',
      detail: `尺寸是 ${width}×${height}，应为 ${APP_ICON_SIZE}×${APP_ICON_SIZE}`,
    }
  }

  const conflict = desktopEntryConflict()
  if (conflict !== null) {
    return { ok: false, failure: 'desktop-entry-conflict', detail: conflict }
  }

  const path = customIconPath()
  const previous = existsSync(path) ? readFileSync(path) : null

  try {
    writeAtomically(path, bytes, 0o600)
  } catch (error) {
    return { ok: false, failure: 'write-failed', detail: (error as Error).name }
  }

  try {
    writeDesktopEntry(path)
  } catch (error) {
    restoreIconFile(path, previous)
    invalidate()
    return { ok: false, failure: 'write-failed', detail: (error as Error).name }
  }

  invalidate()
  applyAppIconToWindows()
  logger.info('appicon: custom icon applied', { desktopEntry: app.isPackaged })

  return { ok: true, state: appIconState() }
}

/**
 * 恢复默认图标：删掉自定义图标文件，以及**我们自己写的**那份启动器条目。
 *
 * 别人写的同名片条不动 —— 删掉它等于替用户改了他自己的配置。
 */
export function resetAppIcon(): AppIconResult {
  try {
    rmSync(customIconPath(), { force: true })
    if (isManagedDesktopEntry()) rmSync(desktopEntryPath(), { force: true })
  } catch (error) {
    return { ok: false, failure: 'write-failed', detail: (error as Error).name }
  }

  invalidate()
  applyAppIconToWindows()
  logger.info('appicon: reset to the default icon')

  return { ok: true, state: appIconState() }
}
