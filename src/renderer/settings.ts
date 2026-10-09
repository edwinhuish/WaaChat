/**
 * 「设置」窗口的入口。
 *
 * 设置项与接管状态同属"应用当前的行为是什么"（图标生效范围、迁移进度、缓存开关），
 * 因此它们在同一个窗口里 —— 状态标签**不**放文件列表窗口，理由与代价见 [ADR-0025]
 * 理由 5。
 *
 * 窗口卸载时要取消订阅：本地界面窗口可以被关闭（只是隐藏），真正卸载时若不取消，
 * 窗口每次重建都会多留一个监听器，表现为"同一次接管被提示多次"。
 */

import { part } from './dom'
import { fatal } from './fatal'
import { mountHealthView } from './views/health'
import { mountSettingsView } from './views/settings'

function main(): void {
  const settings = mountSettingsView(part(document, 'settings-list'))
  const health = mountHealthView(part(document, 'capture-status'))

  void settings.refresh()
  void health.refresh()

  window.addEventListener('unload', () => {
    health.dispose()
    settings.dispose()
  })
}

try {
  main()
} catch (error) {
  fatal(error)
}
