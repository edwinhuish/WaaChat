/**
 * 顶栏的接管状态。
 *
 * 为什么这个小东西值得单独一个模块、还常驻在顶栏：
 *
 *   本项目最糟的失败模式不是崩溃，而是**安静地退回上游的原生行为** ——
 *   文件又被下载到 `~/Downloads`，应用什么也不说。用户会以为是自己的操作错了，
 *   然后去文件夹里翻，而这恰好是本项目要消灭的行为。
 *
 * 所以状态必须**一直可见**，而不是藏在设置页深处。同时它也只是状态：
 * 不弹窗、不打断，因为接管失败时应用仍然可用。
 */

import type { CaptureHealth } from '../../shared/types'
import { describeCaptureFailure, formatTimestamp } from '../../shared/format'
import { bridge } from '../bridge'
import { h } from '../dom'

export interface HealthView {
  /** 主动拉一次（窗口刚打开、或从后台恢复时用）。 */
  refresh(): Promise<void>
  /** 取消订阅。窗口卸载时调用。 */
  dispose(): void
}

export function mountHealthView(container: HTMLElement): HealthView {
  function render(health: CaptureHealth): void {
    container.replaceChildren(...pills(health))
  }

  const unsubscribe = bridge().onCaptureHealthChanged(render)

  return {
    async refresh(): Promise<void> {
      render(await bridge().getCaptureHealth())
    },
    dispose(): void {
      unsubscribe()
    },
  }
}

/**
 * 生成状态标签。
 *
 * 优先级：错误 > 最近接管 > 空态。错误排最前，因为它需要用户动作
 * （清理磁盘、装一个应用、提 issue）——被"最近接管成功"的绿色标签盖住就没人会看到。
 */
function pills(health: CaptureHealth): HTMLElement[] {
  const result: HTMLElement[] = []

  if (health.lastError !== null) {
    const message = describeCaptureFailure(health.lastError)
    result.push(
      h('span', { class: 'pill', text: '接管异常', title: message, data: { state: 'error' } }),
    )
  } else if (health.lastCaptureAt !== null) {
    result.push(
      h('span', {
        class: 'pill',
        text: `上次接管 ${formatTimestamp(health.lastCaptureAt)}`,
        data: { state: 'ok' },
      }),
    )
  } else {
    result.push(h('span', { class: 'pill', text: '尚无接管记录', data: { state: 'unknown' } }))
  }

  // 密文缓存的开关状态需要重启才变，但它的**当前生效值**必须可见：
  // 否则用户无法判断"第二次打开还要联网"是设置没开，还是缓存坏了。
  result.push(
    h('span', {
      class: 'pill',
      text: health.ciphertextCacheActive ? '密文缓存：开' : '密文缓存：关',
      title: health.ciphertextCacheActive
        ? '重复打开同一个文件不会再走网络。'
        : '每次打开都会重新从 CDN 拉取。可在设置里开启（需重启）。',
      data: { state: health.ciphertextCacheActive ? 'ok' : 'unknown' },
    }),
  )

  return result
}
