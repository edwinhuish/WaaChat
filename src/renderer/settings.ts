/**
 * 「设置」窗口的入口。
 *
 * 这一页只有偏好设置（[ADR-0042]）：原来它还挂着顶栏的品牌名与"接管状态"几颗标签，而那几颗
 * 标签里"尚无接管记录 / 上次接管 …"既没有信息量又占地方。接管**失效**改由系统通知告知
 * （`main/notice.ts`）—— 那条通道只在出事时响一次，比一颗总要用户主动看一眼的静态标签更容易
 * 被看见。
 *
 * 窗口卸载时要取消订阅：本地界面窗口可以被关闭（只是隐藏），真正卸载时若不取消，窗口每次重建
 * 都会多留一个监听器，表现为"同一次迁移进度被推两次"。
 */

import { part } from './dom'
import { fatal } from './fatal'
import { mountSettingsView } from './views/settings'

function main(): void {
  const settings = mountSettingsView(part(document, 'settings-list'))

  void settings.refresh()

  window.addEventListener('unload', () => {
    settings.dispose()
  })
}

try {
  main()
} catch (error) {
  fatal(error)
}
