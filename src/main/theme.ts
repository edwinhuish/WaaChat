/**
 * 把主题落到 Electron 上。
 *
 * 判据在 `shared/theme.ts`（取值、窗口底色）；这里只做它做不到的两件事：改
 * `nativeTheme.themeSource`，以及把底色刷到**已经存在**的窗口上。
 *
 * ⚠️ `themeSource` 是**进程级**的，而且它同时决定渲染进程看到的 `prefers-color-scheme`
 * —— 因此一次赋值同时改到三处：我们两扇本地窗口的样式、`BrowserWindow.backgroundColor`、
 * 以及内嵌页面在"跟随系统"时的表现（边界逐条写在 `shared/theme.ts` 的文件头）。
 */

import { BrowserWindow, nativeTheme } from 'electron'

import { windowBackground, type ThemeSource } from '../shared/theme'
import { logger } from './logger'

/** 当前该用的窗口底色（"跟随系统"时取系统当前的深浅）。 */
export function currentWindowBackground(): string {
  return windowBackground(nativeTheme.shouldUseDarkColors)
}

/**
 * 应用一个主题 —— 启动时与改设置时都走它（[ADR-0078]）。
 *
 * ⚠️ 必须在**任何窗口被创建之前**调用一次：窗口的 `backgroundColor` 在构造时就取了
 * {@link currentWindowBackground}，而"跟随系统"时那个值取决于系统**当时**的深浅。
 */
export function applyTheme(source: ThemeSource): void {
  nativeTheme.themeSource = source
  paintWindowBackgrounds()

  /**
   * 记一条：`themeSource` 是进程级的，而"窗口为什么是深色"在用户那里只有两个可能的原因
   * （系统是深色 / 他自己选了深色）—— 这条日志把两者分开，省一次来回。
   */
  logger.info('theme applied', { source, dark: nativeTheme.shouldUseDarkColors })
}

/**
 * 系统主题变了就跟着刷新窗口底色（`themeSource === 'system'` 时用户在桌面里切了深色）。
 *
 * 只刷底色：我们界面的颜色与内嵌页面都由 `prefers-color-scheme` 自动跟随，不需要我们插手。
 * 底色是**唯一**一处内核不会自己更新的地方 —— 不跟上的症状是"深色桌面下，窗口在内容画出来
 * 之前闪一下白"，而它每次切主题都会出现一次。
 */
export function attachThemeSync(): void {
  nativeTheme.on('updated', paintWindowBackgrounds)
}

function paintWindowBackgrounds(): void {
  const background = currentWindowBackground()

  for (const window of BrowserWindow.getAllWindows()) {
    // 窗口可能正在销毁：`setBackgroundColor()` 对已销毁的窗口会抛。
    if (!window.isDestroyed()) window.setBackgroundColor(background)
  }
}
