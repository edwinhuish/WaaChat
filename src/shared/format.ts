/**
 * 展示层的纯格式化函数。
 *
 * 放在 `shared/` 是因为**主进程与界面都要用**：桌面通知里要显示体积，归档列表
 * 里也要显示体积。各写一份的后果是两处的取整规则慢慢分叉 —— 同一个文件在通知里
 * 是 "1.5 MB"、在列表里是 "2 MB"，用户会以为看到了两个不同的东西。
 */

import type { CaptureFailure } from './types'

/** 人类可读的字节数。基数 1024，保留一位小数直到两位数。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`

  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = bytes / 1024
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  // 三位有效数字读起来最舒服：9.9 MB 比 9.94 MB 易读，而 12 MB 不需要小数。
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`
}

/** 归档列表里的时间。用本地时区与本地格式 —— 这是给人看的，不是给机器解析的。 */
export function formatTimestamp(ms: number, locale = 'zh-CN'): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return new Date(ms).toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * 把接管失败的原因翻译成用户能理解的一句话。
 *
 * `CaptureFailure` 是给程序看的结构化联合；界面直接显示 `kind` 会得到
 * "cache-key-unstable" 这种对用户毫无意义的字符串。
 *
 * 末尾的 `never` 断言不是装饰：新增一种失败原因时**编译会失败**，从而强制补上
 * 人话翻译。没有它，新原因会静默走进 `default`，用户看到一句含糊的"未知错误"。
 */
export function describeCaptureFailure(failure: CaptureFailure): string {
  switch (failure.kind) {
    case 'download-event-missing':
      return '没有收到下载事件，可能是上游改版。文件可能被下载到了「下载」目录。'
    case 'write-failed':
      return `写入归档失败（${failure.reason}），磁盘可能已满或权限不足。`
    case 'open-failed':
      return '文件已归档，但没有应用能打开它。检查系统的默认应用设置。'
    case 'too-large':
      return `文件超过单次接管上限（${formatBytes(failure.bytes)}），已按上游原生方式下载。`
    case 'cache-key-unstable':
      return '缓存键推导失败，二次打开仍会联网（不影响打开本身）。'
    default: {
      const unhandled: never = failure
      return `接管出现未知错误（${String(unhandled)}）。`
    }
  }
}
