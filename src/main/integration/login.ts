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

import { usingDefaultInstance } from '../instance'
import { logger } from '../logger'

export function applyLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return

  /**
   * 自启条目是**全机一份**的：Electron 按应用名在 `~/.config/autostart/` 下写一个
   * `.desktop`，因此两个实例会争抢同一个文件、互相覆写（多实例，[ADR-0062]）。
   *
   * 归属交给默认实例。**不做成"每个实例各写一条"**：那要求条目有不同的名字，而
   * `setLoginItemSettings()` 不给我们指定名字的能力 —— 在这些约束下能做的只有"不互相
   * 覆写"。命名实例想开机启动，用自己的启动器条目或一个 `--instance` 包装脚本
   * （`docs/usage.md` 第 5 节）。
   */
  if (!usingDefaultInstance()) {
    logger.info('login: autostart belongs to the default instance, skipping', { enabled })
    return
  }

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
