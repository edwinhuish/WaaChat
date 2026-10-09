/**
 * 「文件列表」窗口的入口。
 *
 * 一扇窗口一个入口（[ADR-0025]）：这里只挂文件列表，不挂设置。因此没有标签切换，
 * 也没有"切回来要不要刷新"的判断 —— 那类状态是"两个页面挤在一扇窗口里"的代价。
 *
 * 卸载时不需要取消订阅：归档视图没有订阅任何推送（迁移进度与接管状态都在设置窗口）。
 */

import { part } from './dom'
import { fatal } from './fatal'
import { mountArchiveView } from './views/archive'

function main(): void {
  const view = mountArchiveView(
    part(document, 'archive-list'),
    part(document, 'archive-footer'),
    part<HTMLInputElement>(document, 'archive-search'),
    part<HTMLButtonElement>(document, 'archive-refresh'),
  )

  void view.refresh()
}

try {
  main()
} catch (error) {
  fatal(error)
}
