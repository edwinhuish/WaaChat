/**
 * 主动告诉用户一件事（目前只有一条：PDF 预览被挡下了）。
 *
 * 为什么单独一个模块：它 import `Notification`（electron），因此**不能**待在
 * `capture/pdf.ts` 里 —— 那个模块只 `import type` electron，离线自检要能直接引用它
 * （`ai/CONVENTIONS.md` 第 8 节）。于是这里做 IO，判据与文案留在
 * `shared/preview-notice.ts`（纯函数，可单测）。
 *
 * 用系统通知而不是弹窗：弹窗会打断且必须点掉，而这件事只是"提个醒"——用户可能正打算改用
 * 消息上的下载按钮。这也与页面自己的消息通知同一条通道（`permissions.ts` 允许 `notifications`）。
 */

import { Notification } from 'electron'

import {
  PREVIEW_BLOCKED_BODY,
  PREVIEW_BLOCKED_TITLE,
  shouldAnnouncePreviewBlocked,
} from '../shared/preview-notice'
import { logger } from './logger'

/** 上次提示的时刻（模块级：进程内节流，不持久化 —— 重启后重新计一次没有坏处）。 */
let lastPreviewBlockedAt: number | null = null

/**
 * 提示"这次预览被挡下了，请用消息上的下载"。
 *
 * 幂等且**廉价**：节流判据在真正弹之前就返回，因此调用方（请求拦截器）可以每次命中都调用它。
 * 失败一律不影响主流程 —— 这条通知只是"允许失效时必须可见"里的那点可见性。
 */
export function announcePreviewBlocked(): void {
  const now = Date.now()
  if (!shouldAnnouncePreviewBlocked(lastPreviewBlockedAt, now)) return

  lastPreviewBlockedAt = now

  try {
    if (!Notification.isSupported()) {
      // 桌面环境没有通知服务（纯 WM 的会话、容器里跑）—— 记一条日志，而不是假装提示过了。
      logger.warn('notice: this desktop has no notification service')
      return
    }

    new Notification({ title: PREVIEW_BLOCKED_TITLE, body: PREVIEW_BLOCKED_BODY }).show()
    logger.info('notice: told the user how to fetch the blocked PDF')
  } catch (error) {
    logger.warn('notice: could not show a notification', { reason: (error as Error).name })
  }
}
