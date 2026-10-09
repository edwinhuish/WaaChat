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

import { Menu, Tray, app } from 'electron'
import type { BrowserWindow } from 'electron'

import { logger } from '../logger'
import { presentWindow } from '../window'
import { effectiveAppIcon } from './appicon'

/**
 * 托盘要打开的三扇窗口。
 *
 * ⚠️ 本地界面是**两扇**窗口（文件列表 / 设置，见 [ADR-0025]），因此不能像以前那样只留
 * 一个 `localWindow` 引用 —— 托盘的每一项各对应一扇，指错了就是"点设置打开了列表"。
 */
export interface TrayWindows {
  readonly files: BrowserWindow
  readonly settings: BrowserWindow
  readonly main: BrowserWindow
}

let tray: Tray | null = null

/**
 * 当前托盘，供"换了图标要立刻反映到托盘上"的调用方使用（见 `ipc/index.ts`）。
 *
 * 托盘可能整个不存在（缺 Ayatana 支持），因此返回 `null` 是正常路径，调用方不必区分。
 */
export function getTray(): Tray | null {
  return tray
}

export function createTray(windows: TrayWindows): Tray | null {
  if (tray !== null) return tray

  try {
    /**
     * 与窗口用同一个来源（`integration/appicon.ts`）。**不要**在这里另读一次文件：
     * 那样"自定义图标"就要在各处分别实现一遍，而漏掉其中一处的外观症状是
     * "托盘换了、窗口没换" —— 看起来像随机故障。
     */
    const image = effectiveAppIcon()
    if (image === null) {
      logger.warn('tray: icon not found, continuing without a tray icon')
      return null
    }

    tray = new Tray(image)
    tray.setToolTip('WaaChat')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示聊天', click: () => presentWindow(windows.main) },
        // 两项各开一扇窗口：本地界面拆开之后，托盘不再需要"打开某一扇再自己找"。
        { label: '文件列表', click: () => presentWindow(windows.files) },
        { label: '设置', click: () => presentWindow(windows.settings) },
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
     *
     * 激活指向**聊天**窗口（本应用的主体），而不是两扇本地界面窗口中的某一扇。
     */
    tray.on('click', () => presentWindow(windows.main))

    return tray
  } catch (error) {
    // 缺少 Ayatana 支持时会走到这里。功能降级，但应用仍然可用 ——
    // 不要因为一个托盘图标让整个应用起不来。
    logger.warn('tray: unavailable, continuing without it', { reason: (error as Error).name })
    return null
  }
}
