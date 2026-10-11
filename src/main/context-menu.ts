/**
 * 承载上游页面的窗口的右键菜单。
 *
 * 它存在的**唯一**理由是拼写检查的建议：Electron 不像浏览器那样自带右键菜单（不处理
 * `context-menu` 这个事件，右键就是毫无反应），而"哪一段选错了、改成什么"这两件事只有内核
 * 算得出来 —— 我们负责把它们端出来。
 *
 * 因此这个菜单只做与**输入**有关的事（拼写建议 + 剪切/复制/粘贴/全选），不碰页面的任何功能：
 * 上游网页版没有提供依赖右键的能力，而我们也不该替它发明一个。
 *
 * 它不是"给页面加了一层 UI"：菜单是**原生**控件，往文档里一个字节都没写（与 [INV-1] 无关）。
 * 这与拼写检查本身是同一条理由 —— 红线由渲染进程画，建议由主进程弹，页面全程只是内容。
 */

import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

import { logger } from './logger'

/**
 * 给一扇窗口装上右键菜单。
 *
 * 只挂我们主动打开的这一扇（承载上游页面）—— 两扇本地界面沿用它们原来的行为，不在这里
 * 顺带扩权：给一个只有搜索框的窗口加菜单，收益为零，而"哪扇窗口有菜单"从此多一种可能。
 */
export function attachContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    const template: MenuItemConstructorOptions[] = []

    if (params.misspelledWord !== '') {
      /**
       * 建议由内核给（`dictionarySuggestions`）。**有可能一个都没有** —— 那门词典还没下载完、
       * 或者这个词生僻到它不认识。此时给出一个禁用的说明项而不是弹一个空菜单：
       * "右键了但什么都没有"会被当成功能坏了。
       */
      if (params.dictionarySuggestions.length === 0) {
        template.push({ label: '没有拼写建议', enabled: false })
      } else {
        for (const suggestion of params.dictionarySuggestions) {
          template.push({
            label: suggestion,
            click: () => {
              // 菜单弹着的时候窗口理论上还活着；真被关掉就不做（回一个标点比抛错好）。
              if (window.isDestroyed()) return
              window.webContents.replaceMisspelling(suggestion)
            },
          })
        }
      }

      template.push({ type: 'separator' })
    }

    if (params.isEditable) {
      /**
       * 可用与否**照抄**内核算好的 `editFlags`，不自己判断：自己判会得到"粘贴项是灰的、而
       * Ctrl+V 明明能粘"这类不一致，用户无法理解为什么两种说法不一样。
       *
       * ⚠️ 每一项都显式给了 `label`，**不要**去掉（自检第 19 节断言它们都在）。
       *
       * `role` 的默认文案来自 Chromium 自己的 locale，而那个 locale 会被「界面语言」那一项
       * 一起切走（`main/index.ts` 的 `--lang`，[ADR-0063]）。也就是说：把内嵌页面切成英文的
       * 用户，右键菜单会变成 Cut / Copy / Paste / Select All —— 而这是我们**自己**的界面，
       * 它的文案必须是中文（`ai/CONVENTIONS.md` 第 1 节）。给 `role` 项配 `label` 不会改变
       * 它的行为，只是不让别人替我们决定说什么语言。
       */
      template.push(
        { role: 'cut', label: '剪切', enabled: params.editFlags.canCut },
        { role: 'copy', label: '复制', enabled: params.editFlags.canCopy },
        { role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste },
        { role: 'selectAll', label: '全选', enabled: params.editFlags.canSelectAll },
      )
    } else if (params.selectionText !== '') {
      // 页面里选中了一段文字（不是输入框）：只给「复制」。别的一律不该由我们提供。
      template.push({ role: 'copy', label: '复制' })
    }

    // 空白处右键：什么都不弹（模板为空时 `popup()` 会得到一张空菜单）。
    if (template.length === 0) return

    Menu.buildFromTemplate(template).popup({ window })
  })

  logger.info('main window: context menu attached')
}
