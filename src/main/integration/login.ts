/**
 * 开机自启。
 *
 * Linux 下 Electron 的实现是往 `~/.config/autostart/` 写一个 `.desktop` 条目，
 * 因此在**开发模式下必须跳过** —— `pnpm run dev` 是临时行为，不该在用户的
 * 会话里留下一个指向 `node_modules/electron` 的自启条目。
 *
 * AppImage 需要特别处理：此时 `process.execPath` 指向被挂载出来的临时目录
 * （`/tmp/.mount_XXXX/waachat`），把它写进自启条目毫无意义 —— 下次登录那个路径早已
 * 不存在。真正的可执行文件由 `APPIMAGE` 环境变量指出。
 */

import { app } from 'electron'

import { logger } from '../logger'

export function applyLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return

  const appImage = process.env['APPIMAGE']
  const path = appImage ?? process.execPath

  try {
    app.setLoginItemSettings({ openAtLogin: enabled, path, args: [] })
    logger.info('login: autostart updated', { enabled, fromAppImage: appImage !== undefined })
  } catch (error) {
    // 自启失败不影响应用可用性，但要让用户看到它没生效 —— 静默失败等于缺陷。
    logger.warn('login: could not update autostart', { reason: (error as Error).name })
  }
}
