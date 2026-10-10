/**
 * 批量导出的人话（[ADR-0050]）。
 *
 * 与 `migration.ts` / `cache-conversion.ts` 同样的理由：主进程要拿它填错误对话框，界面要拿它
 * 填结果行。**文案只有这一份** —— 各写一份的后果是同一个失败在两处措辞不同，用户会以为是
 * 两件事，或者更糟：其中一处忘了随新增的原因更新。
 *
 * 两个 `never` 断言不是装饰：新增一种原因时**编译会失败**，从而强制补上翻译。没有它，
 * 新原因会静默走进 `default`，用户看到一句含糊的"未知错误"。
 */

import type {
  ArchiveExportFailure,
  ArchiveExportFailureItem,
  ArchiveExportRejection,
} from './types'

/**
 * 整次调用被拒绝时的一句话。
 *
 * `detail` 是具体信息（路径、条数），**给用户看的** —— 不要写进日志（INVARIANTS G-3）。
 */
export function describeExportRejection(reason: ArchiveExportRejection, detail: string): string {
  switch (reason) {
    case 'inside-archive':
      return '导出目标不能是归档目录本身，也不能在它里面 —— 那些文件会被归档当成"来路不明"（不清理、也不统计）。换一个目录再试。'
    case 'too-many':
      return `一次最多导出 ${detail} 个文件。分几次来。`
    case 'target-unusable':
      return `目标目录用不了：${detail}`
    default: {
      const unhandled: never = reason
      return `导出出现未知错误（${String(unhandled)}）。`
    }
  }
}

/** 单条失败的原因。逐条说出来，因为三种原因用户该做的事完全不同。 */
export function describeExportFailure(reason: ArchiveExportFailure): string {
  switch (reason) {
    case 'missing':
      return '归档里已经没有这个文件了（被清理过）'
    case 'name-taken':
      return '目标目录里同名文件太多，换一个目录再试'
    case 'write-failed':
      return '写入失败（磁盘可能已满，或目标目录不可写）'
    default: {
      const unhandled: never = reason
      return `未知错误（${String(unhandled)}）`
    }
  }
}

/**
 * 一次导出的结果行。
 *
 * 三件事都要说：**成功几个**、**去哪了**、**哪几个没成功、为什么**。只报成功数会让"少了两个
 * 文件"变成一件需要用户自己发现的事（`ai/CONVENTIONS.md` 第 4 节）。
 *
 * 成功且全部成功时仍然说出来 —— 用户点完按钮需要一个确认，而不是靠"没报错"推断。
 */
export function describeExportResult(result: {
  readonly dir: string
  readonly exported: number
  readonly failed: readonly ArchiveExportFailureItem[]
}): string {
  const where = `（${result.dir}）`
  const head =
    result.failed.length === 0
      ? `已导出 ${result.exported} 个文件${where}。`
      : `已导出 ${result.exported} 个文件，${result.failed.length} 个失败${where}。`

  if (result.failed.length === 0) return head

  // 失败逐条列出来。同一个原因合并成一句，否则 200 条失败会把结果行撑成一堵墙。
  const byReason = new Map<ArchiveExportFailure, string[]>()
  for (const item of result.failed) {
    const label = item.name ?? '（一条已不在归档里的记录）'
    byReason.set(item.reason, [...(byReason.get(item.reason) ?? []), label])
  }

  const lines = [...byReason].map(
    ([reason, names]) =>
      `${describeExportFailure(reason)}：${names.slice(0, 3).join('、')}${
        names.length > 3 ? ` 等 ${names.length} 个` : ''
      }`,
  )

  return [head, ...lines].join('\n')
}
