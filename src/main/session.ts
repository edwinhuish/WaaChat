/**
 * 会话配置。
 *
 * 两个接管点都挂在这里，因此 `configureSession` **必须**在任何窗口创建之前调用 ——
 * 晚一步就会错过早期的下载与请求。
 */

import type { Session } from 'electron'

import type { Settings } from '../shared/types'
import { isUpstreamOrigin } from '../shared/upstream'
import { attachDownloadCapture } from './capture/download'
import { attachCiphertextCache } from './capture/protocol'
import { logger } from './logger'

/**
 * 允许上游页面申请的权限。
 *
 * 白名单而非黑名单：将来上游申请一个新权限时，默认结果是"拒绝"，而不是
 * 静默放行。**同时校验来源**，因为同一个分区里还有我们自己的本地界面窗口。
 *
 * 来源判据用 {@link isUpstreamOrigin} 做 origin 精确比对 —— 不能写前缀匹配：
 * `https://web.whatsapp.com@evil.com/` 也会以前缀的形式通过，于是摄像头 /
 * 麦克风权限被交给一个第三方页面（docs/security.md T5）。
 */
const ALLOWED_PERMISSIONS = new Set([
  'notifications',
  'media', // 麦克风 / 摄像头：通话与语音消息需要
  'clipboard-sanitized-write',
  'fullscreen',
])

export function configureSession(ses: Session, getSettings: () => Settings): void {
  // 这一次性决策（权限、密文缓存开关）用当时的取值。订阅层次的选择在会话建立时
  // 就固定了，运行期改不了 —— 见 shared/types.ts 的 RESTART_REQUIRED_SETTINGS。
  const settings = getSettings()

  // --- 权限 -----------------------------------------------------------------
  ses.setPermissionRequestHandler((contents, permission, callback) => {
    const fromUpstream = isUpstreamOrigin(contents.getURL())
    const allowed = fromUpstream && ALLOWED_PERMISSIONS.has(permission)
    if (!allowed) {
      logger.warn('permission denied', { permission, fromUpstream })
    }
    callback(allowed)
  })

  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return isUpstreamOrigin(requestingOrigin) && ALLOWED_PERMISSIONS.has(permission)
  })

  /**
   * 屏幕共享。
   *
   * 必须显式提供处理器，否则 getDisplayMedia 会直接失败。`useSystemPicker` 让
   * Wayland 下的 xdg-desktop-portal 选择器接管 —— 这比自己枚举屏幕列表更正确，
   * 也避免把用户的所有窗口标题暴露给页面。
   *
   * 若平台不提供系统选择器，处理器会被调用，此时拒绝而不是替用户随便选一个源。
   */
  ses.setDisplayMediaRequestHandler(
    () => {
      logger.warn('display media requested but no system picker available; denying')
    },
    { useSystemPicker: true },
  )

  // --- 接管点 A：下载事件 -----------------------------------------------------
  // 这一层是"点击即开"的全部实现，也是 M1 的验收目标。
  // 传的是**读取函数**而不是快照：用户在偏好设置里改了"点击时自动打开"，
  // 要立刻生效，而不是等下次重启。
  attachDownloadCapture(ses, getSettings)

  // --- 接管点 B：密文缓存 -----------------------------------------------------
  // 可关闭。关闭后只影响"二次打开是否联网"，不影响正确性。
  if (settings.enableCiphertextCache) {
    attachCiphertextCache(ses)
  }

  logger.info('session configured', {
    ciphertextCache: settings.enableCiphertextCache,
    openOnCapture: settings.openOnCapture,
  })
}
