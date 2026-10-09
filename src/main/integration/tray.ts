/**
 * 系统托盘。
 *
 * 托盘在本项目里不是"锦上添花"，而是**必需品**：应用常驻后台才能维持上游页面的
 * 长连接，从而让通知正常到达。没有托盘，用户就没有"退出"的入口 ——
 * 因为关闭窗口只是隐藏（见 window.ts 的 hideOnClose）。
 *
 * 平台差异要接受：GNOME 默认不显示托盘图标，需要 AppIndicator 扩展
 * （`gnome-shell-extension-appindicator`，deb 里作为 recommends）。
 * 缺失时的行为是**降级为没有托盘**，而不是启动失败。
 */

import { join } from 'node:path'

import { Menu, Tray, app, nativeImage } from 'electron'
import type { BrowserWindow } from 'electron'

import { logger } from '../logger'
import { presentWindow } from '../window'

export interface TrayWindows {
  readonly localWindow: BrowserWindow
  readonly mainWindow: BrowserWindow
}

let tray: Tray | null = null

/**
 * 托盘图标路径。
 *
 * 打包后图标来自 `extraResources`（见 electron-builder.yml）—— 不能指望它出现在
 * `out/` 里，因为那里只有编译产物。
 */
function trayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
}

export function createTray(windows: TrayWindows): Tray | null {
  if (tray !== null) return tray

  try {
    const image = nativeImage.createFromPath(trayIconPath())
    if (image.isEmpty()) {
      logger.warn('tray: icon not found, continuing without a tray icon')
      return null
    }

    tray = new Tray(image)
    tray.setToolTip('WaaChat')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示聊天', click: () => presentWindow(windows.mainWindow) },
        { label: '归档', click: () => presentWindow(windows.localWindow) },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            // 触发 before-quit，让退出清理（若用户开启）有机会执行。
            app.quit()
          },
        },
      ]),
    )

    /**
     * Linux 上这个事件不是"鼠标左键单击"，而是 StatusNotifierItem 的 `Activate`
     * 调用：哪种操作算激活由桌面环境决定（GNOME 的 appindicator 扩展要求双击），
     * 且在某些实现里根本不会发出。所以窗口的入口**不能只靠这一条** —— 上面那份
     * 上下文菜单里的「显示聊天」才是保底入口。
     */
    tray.on('click', () => presentWindow(windows.mainWindow))

    return tray
  } catch (error) {
    // 缺少 Ayatana 支持时会走到这里。功能降级，但应用仍然可用 ——
    // 不要因为一个托盘图标让整个应用起不来。
    logger.warn('tray: unavailable, continuing without it', { reason: (error as Error).name })
    return null
  }
}
