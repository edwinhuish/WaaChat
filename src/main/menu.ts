/**
 * 应用菜单。
 *
 * 它替换的是 **Electron 自己装的那份默认菜单**：我们从未调用过 `Menu.setApplicationMenu()`，
 * 而 Electron 在启动时会装一份（File / Edit / View / Window / Help，文案是英文，视图里带着
 * Force Reload 与 Toggle DevTools，帮助里是一条会去打开 electronjs.org 的 "Learn More about
 * Electron"）。三扇窗口都是 `autoHideMenuBar: true`，因此那条菜单栏平时**看不见** ——
 * 但 Alt 一按就出来，而且**它的快捷键一直在生效**。这带来两个后果，也正是这里必须自己装一份的理由：
 *
 *   1. **快捷键就等于这份模板。** 菜单栏隐藏不影响 accelerator 注册，因此"Ctrl+Q 能不能退出 /
 *      能不能缩放"全由这里决定，而不是由某个窗口的属性决定。
 *   2. **它是一条与托盘无关的入口。** 托盘在不少桌面环境上根本不显示（GNOME 要 AppIndicator
 *      扩展），而"桌面上到底有没有那个图标"**检测不到**（[ADR-0034]：没有任何指示器宿主时
 *      `new Tray()` 依然成功）。菜单栏是唯一始终存在的第二个入口，因此「显示聊天 / 文件列表 /
 *      设置」在这里也各有一项 —— 与托盘菜单是**同一批目的地**，不是两套功能。
 *
 * 两条纪律：
 *
 *   - **每一个 `role` 项都显式给中文 `label`。** `role` 的默认文案取自 Chromium 自己的
 *     locale，而系统 locale 可能是英文（[ADR-0066] 之后 locale 不再由我们改，但结论照旧）——
 *     那会让我们**自己的**菜单里出现 Cut / Copy。断言与右键菜单同一条
 *     （`scripts/check-capture.ts` 的"应用菜单"那一节）。
 *   - **不暴露内核的调试入口。** `reload` 留着：它是页面卡住时唯一的应用内恢复手段，而且是标准
 *     浏览器动作 —— 它重新加载上游页面，不往文档里写一个字节（与 [INV-1] 无关）。`forceReload`
 *     与 `toggleDevTools` **不留**：后者会把一个已登录页面的完整文档与网络面板交给一次按键，
 *     而我们的调试路径是只读探针（[ADR-0046] / `ai/TASKS.md` T12）。
 */

import { Menu } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'

import { logger } from './logger'
import { presentWindow } from './window'
import { resetZoom, stepZoom } from './zoom'

/**
 * 菜单要打开的三扇窗口。
 *
 * 与 `TrayWindows` 同形（三扇窗口各对应一扇，见 [ADR-0025]）：两处入口指向**同一批目的地**，
 * 因此形状也用同一个 —— 少一扇就会变成"菜单里点设置、开出来的是文件列表"。
 */
export interface AppMenuWindows {
  readonly files: BrowserWindow
  readonly settings: BrowserWindow
  readonly main: BrowserWindow
}

/**
 * 装应用菜单（替换 Electron 的默认菜单）。
 *
 * 必须在窗口创建**之后**调用：菜单项要的正是那三扇窗口的引用。
 */
export function installApplicationMenu(windows: AppMenuWindows): void {
  const template: MenuItemConstructorOptions[] = [
    /**
     * 「文件」= 那三扇窗口 + 退出。
     *
     * 与托盘菜单分组同一条理由：上面三类是"去哪一扇窗口"，退出是"结束整个应用"，
     * 因此它们之间要有分隔线。
     */
    {
      label: '文件',
      submenu: [
        { label: '显示聊天', click: () => presentWindow(windows.main) },
        { label: '文件列表', click: () => presentWindow(windows.files) },
        { label: '设置…', click: () => presentWindow(windows.settings) },
        { type: 'separator' },
        /**
         * 退出走 `role: 'quit'`（= `app.quit()`），因此 `before-quit` 的退出清理照常执行 ——
         * 「退出时清除归档」与关库都挂在那条路径上。⚠️ **不要**换成 `app.exit()`：
         * 那会跳过全部收尾（`restart.ts` 里有一条同样的纪律）。
         */
        { role: 'quit', label: '退出' },
      ],
    },
    /**
     * 「编辑」：输入框要用的那几项。
     *
     * 它们**不能**省：`role` 项同时负责注册快捷键，而承载聊天的那扇窗口里只有一个网页版输入框
     * —— 剪切/复制/粘贴/全选在页面里的行为由内核处理，但"有菜单项"才是它们长期存在的形式
     * （右键菜单里也有同样四项，两者互不替代：一个是键盘、一个是鼠标）。
     */
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        /**
         * 缩放三项（[ADR-0079]）。
         *
         * **不是** `role: 'zoomIn'` 那一组：role 版直接改内核的缩放级别（每扇窗口各记一份、
         * 我们既不知道也存不下来），而这里要的是"三扇窗口共用一个设置、并且重启之后还在"。
         * 点击走 `main/zoom.ts`：算下一档 → 落盘 → 三扇窗口跟上 → 通知设置窗口。
         *
         * 快捷键与自带的那份默认菜单**逐字相同**（`CmdOrCtrl+Plus` / `-` / `0`）—— 这套组合
         * 在浏览器里就是这个意思，换一套反而是我们自己的发明。
         */
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: () => stepZoom(1) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => stepZoom(-1) },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => resetZoom() },
        { type: 'separator' },
        /**
         * 重新加载页面（Ctrl+R）。
         *
         * 上游页面卡住（白屏、面板停在加载态）时，这是**应用内**唯一的恢复手段 —— 没有它就只能
         * 退出再启动。它由内核执行，是标准浏览器动作：不改文档、不注入脚本。
         */
        { role: 'reload', label: '重新加载页面' },
        { type: 'separator' },
        /**
         * 全屏（F11）。通话与媒体查看器都用得上，而且它是上游页面自己的全屏请求之外，
         * 用户唯一能自己进出全屏的入口。
         *
         * ⚠️ 刻意**不**为它加"按 Esc 退出"的钩子：HTML 全屏的 Esc 由内核处理，
         * 我们自己再插一层只会在"窗口全屏"与"页面全屏"之间制造第三种状态。
         */
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        /**
         * `role: 'close'` 触发窗口的 `close` 事件，而它被「关闭窗口 = 隐藏」接管（[ADR-0059]）
         * —— 因此标签必须写清它不会退出应用。
         */
        { role: 'close', label: '关闭窗口（隐藏到托盘）' },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  logger.info('application menu installed')
}
