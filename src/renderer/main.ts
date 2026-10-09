/**
 * 本地界面的入口。
 *
 * 界面只有两块：归档与设置。二者都在启动时一次性挂载，切换标签只是显隐 ——
 * 没有路由、没有框架、没有状态容器。对这个规模的界面来说，任何抽象都只会增加
 * 需要维护的概念。
 */

import { part } from './dom'
import { mountArchiveView, type ArchiveView } from './views/archive'
import { mountHealthView, type HealthView } from './views/health'
import { mountSettingsView, type SettingsView } from './views/settings'

interface Views {
  readonly archive: ArchiveView
  readonly settings: SettingsView
  readonly health: HealthView
}

function mountViews(): Views {
  return {
    archive: mountArchiveView(
      part(document, 'archive-list'),
      part(document, 'archive-footer'),
      part<HTMLInputElement>(document, 'archive-search'),
      part<HTMLButtonElement>(document, 'archive-refresh'),
    ),
    settings: mountSettingsView(part(document, 'settings-list')),
    health: mountHealthView(part(document, 'capture-status')),
  }
}

function mountTabs(views: Views): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('nav button[data-tab]'))

  for (const button of buttons) {
    button.addEventListener('click', () => {
      for (const candidate of buttons) {
        const name = candidate.dataset['tab'] ?? ''
        const selected = candidate === button

        candidate.setAttribute('aria-selected', String(selected))

        const section = document.querySelector<HTMLElement>(`#view-${name}`)
        if (section !== null) section.hidden = !selected
      }

      /**
       * 切回来时刷新。
       *
       * 不是为了"实时"——而是因为界面上的数字可能已经过期：用户在设置里改了
       * 「退出时清除归档」不会立刻体现，但在另一个标签页里清过缓存之后，
       * 归档那页的占用数字就是错的。重新读一次的成本是一次 SQLite 查询。
       */
      const name = button.dataset['tab']
      if (name === 'archive') void views.archive.refresh()
      if (name === 'settings') void views.settings.refresh()
    })
  }
}

/**
 * 装配失败的兜底提示。
 *
 * 这条路径只会因为**装配错误**走到（preload 没挂上、界面结构与脚本不匹配），
 * 不会是数据问题。因此直接把原因写在窗口里，而不是留一片空白 ——
 * 空白窗口会让排查者从"渲染进程为什么没起来"开始猜，那要走很远。
 */
function fatal(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const node = document.createElement('pre')
  node.textContent = `界面无法启动：\n\n${message}`
  node.setAttribute(
    'style',
    'padding:24px;white-space:pre-wrap;font-family:ui-monospace,monospace;color:#b42318',
  )
  document.body.replaceChildren(node)
}

function main(): void {
  const views = mountViews()

  mountTabs(views)

  void views.archive.refresh()
  void views.settings.refresh()
  void views.health.refresh()

  // 本地界面窗口可以被关闭（只是隐藏）。真正卸载时取消订阅，
  // 否则窗口每次重建都会多留一个监听器，表现为"同一次接管被提示多次"。
  window.addEventListener('unload', () => {
    views.health.dispose()
    views.settings.dispose()
  })
}

try {
  main()
} catch (error) {
  fatal(error)
}
