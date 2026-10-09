/**
 * 归档迁移的人话。
 *
 * 与 `format.ts` 的 `describeCaptureFailure` 同样的理由：主进程要用它填错误对话框，
 * 界面要用它填状态行。**文案只有这一份** —— 各写一份的后果是同一个失败在两处措辞
 * 不同，用户会以为是两件事，或者更糟：其中一处忘了随新增的失败原因更新。
 */

import type { ArchiveMigrationProgress, MigrationFailure } from './types'

/**
 * 把迁移失败的原因翻译成用户能理解的一句话。
 *
 * 末尾的 `never` 断言不是装饰：新增一种失败原因时**编译会失败**，从而强制补上翻译。
 * 没有它，新原因会静默走进 `default`，用户看到一句含糊的"未知错误"。
 */
export function describeMigrationFailure(failure: MigrationFailure, detail: string): string {
  switch (failure) {
    case 'source-missing':
      return '找不到当前的归档目录，没有可迁移的数据。'
    case 'not-a-directory':
      return `所选位置不是一个目录：${detail}`
    case 'target-not-empty':
      return `所选目录不是空的：${detail}。归档不做合并，请选一个空目录（或先把它清空）。`
    case 'nested-location':
      return '新位置不能是当前归档目录本身，也不能是它的子目录或上级目录。'
    case 'unexpected-content':
      return `归档目录里有无法安全迁移的条目：${detail}。请先手工处理它。`
    case 'write-failed':
      return `写入新位置时失败（${detail}）。磁盘可能已满，或该位置不可写。`
    default: {
      const unhandled: never = failure
      return `迁移出现未知错误（${String(unhandled)}）。`
    }
  }
}

/** 进度文案：「正在迁移 12/40（30%）」。 */
export function describeMigrationProgress(progress: ArchiveMigrationProgress): string {
  if (progress.phase === 'finishing') return '正在收尾…'

  const percent = progress.total === 0 ? 100 : Math.round((progress.done / progress.total) * 100)
  return `正在迁移 ${progress.done}/${progress.total}（${percent}%）`
}
