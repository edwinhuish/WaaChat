/**
 * 未读计数跟踪（[ADR-0080]）。
 *
 * 全部动作只有两步：**拦下页面标题**、把读到的结果交给调用方（托盘徽标与窗口标题）。判据
 * （怎么从标题里读数字、上限 99）在 `shared/unread.ts`，因此这里只处理"什么时候读、谁来记"。
 *
 * ⚠️ 为什么必须 `event.preventDefault()`：
 *
 *   1. **页面标题会覆盖我们给窗口起的名字。** 命名实例靠标题自报家门（[ADR-0062]），而页面
 *      加载完之后那个名字就没了 —— 这是本模块接手之前就存在的一个既有问题，顺手一起修掉。
 *   2. 我们要把未读数写进标题（`… — 3 条未读`），而"页面写一次、我们再写一次"会互相打架
 *      （谁赢取决于时序）。
 *
 * 于是标题的归属权在这里明确下来：**窗口标题由我们决定，页面标题只是一份输入**。
 */

import type { BrowserWindow } from 'electron'

import { formatWindowTitle, parseUnreadCount } from '../shared/unread'
import { instanceLabel } from './instance'
import { logger } from './logger'

/**
 * 盯住这扇窗口的未读数，每次变化都调 `onCount`。
 *
 * 起步就是 `null`（"不知道"），因此调用方一定会先收到一次 —— 托盘因此在启动时就处在"没有未读"
 * 这个确定状态，而不是"等页面说话之前什么都别画"。
 */
export function attachUnreadTracking(
  window: BrowserWindow,
  onCount: (count: number | null) => void,
): void {
  let current: number | null = null
  let started = false
  let logged = false

  const apply = (count: number | null): void => {
    /**
     * 标题会被频繁重写（切会话、上游自己的定时器），而计数通常没变 —— 每次变化都重设一遍标题、
     * 重画一遍托盘图标是纯浪费，而托盘图标的重画在部分指示器实现下还有可见的闪烁。
     */
    if (started && count === current) return

    current = count
    started = true
    window.setTitle(formatWindowTitle(instanceLabel(), count))
    onCount(count)
  }

  // 页面还没说话：标题里不带未读、托盘也没有徽标。
  apply(null)

  window.webContents.on('page-title-updated', (event, title) => {
    // 见文件头：拦下来意味着"窗口标题归我们管"。
    event.preventDefault()

    const count = parseUnreadCount(title)

    /**
     * 只在**第一次**解析时记一条，而且只记**结果**（`count` 可能是 `null`）。
     *
     * 为什么不记标题原文：标题是上游的内容，我们无法保证它永远是"应用名 + 数字"（今天它是），
     * 而一旦上游往里放了别的东西，日志就成了那东西的落点 —— 日志里不该出现会话或联系人名字。
     *
     * 这一条日志的用途是回答"徽标为什么不出来了"：`count: null` 的意思是**格式没认出来**
     * （而不是"没有未读"，那个也会记成 null，因此要配合窗口标题一起看 —— 窗口标题是这一刻的
     * 现场，而它就在用户眼前）。要看原始标题用 `ai/TASKS.md` 的只读探针（T12）。
     */
    if (!logged) {
      logged = true
      logger.info('unread: first page title parsed', { count })
    }

    apply(count)
  })
}
