/**
 * 批量删除的人话（[ADR-0053]）。
 *
 * 与 `export.ts` / `migration.ts` / `cache-conversion.ts` 同样的理由：主进程拿它填错误框与
 * 确认框，界面拿它填结果行。**文案只有这一份** —— 各写一份的后果是同一个失败在两处措辞不同，
 * 用户会以为是两件事，或者更糟：其中一处忘了随新增的原因更新。
 *
 * 两个 `never` 断言不是装饰：新增一种原因时**编译会失败**，从而强制补上翻译。没有它，
 * 新原因会静默走进 `default`，用户看到一句含糊的"未知错误"。
 */

import type {
  ArchiveDeleteFailure,
  ArchiveDeleteFailureItem,
  ArchiveDeleteRejection,
} from './types'

/**
 * 整次调用被拒绝时的一句话。
 *
 * `detail` 是具体信息（条数），**给用户看的** —— 不要写进日志（INVARIANTS G-3）。
 */
export function describeDeleteRejection(reason: ArchiveDeleteRejection, detail: string): string {
  switch (reason) {
    case 'too-many':
      return `一次最多删除 ${detail} 个文件。分几次来。`
    default: {
      const unhandled: never = reason
      return `删除出现未知错误（${String(unhandled)}）。`
    }
  }
}

/** 单条失败的原因。两种原因用户该做的事完全不同：一种不用管，一种要去看磁盘。 */
export function describeDeleteFailure(reason: ArchiveDeleteFailure): string {
  switch (reason) {
    case 'missing':
      return '归档里已经没有这条记录'
    case 'remove-failed':
      return '没能删除（文件可能被其他程序占用，或磁盘只读）'
    default: {
      const unhandled: never = reason
      return `未知错误（${String(unhandled)}）`
    }
  }
}

/**
 * 删除确认框的正文（主进程弹、用户点）。
 *
 * ⚠️ 四件事必须写进去，因为**这一步不可逆**：
 *
 *   1. 会连磁盘上的那份一起删（"从列表里去掉"与"删掉文件"是两件事，用户必须知道是哪一件）；
 *   2. 这是**可以**挽回的 —— 重新在聊天里点一次即可再次归档。不说的话用户会以为文件永久丢了；
 *   3. 同一份内容被别的消息引用时那一份不受影响 —— 否则"删了却没腾出空间"看起来像 bug；
 *   4. 删空的那一层目录会一并收掉（[ADR-0054]）—— 它是本次删除的一个**可见后果**，用户下次
 *      在文件管理器里翻归档时看不到那个会话目录了，不该等到那时才发现。
 */
export function describeDeleteConfirmation(count: number, bytes: string): string {
  return [
    `会把选中的 ${count} 个文件从归档里去掉，磁盘上的那一份也会被删除（共 ${bytes}）。`,
    '这一步不可恢复 —— 需要时重新在聊天里点一次，就会再次归档。',
    '同一份内容还被其他消息引用时，那些消息里的那一份不受影响，因此占用未必会减少。',
    '某条消息的最后一份文件被删掉后，它那一层空目录会一并收掉。',
  ].join('\n')
}

/**
 * 一次删除的结果行。
 *
 * 与 `describeExportResult()` 同构：**成功几个**、**哪几个没成功、为什么**都要说。只报成功数
 * 会让"少了两个文件"变成一件需要用户自己发现的事（`ai/CONVENTIONS.md` 第 4 节）。
 *
 * 成功且全部成功时仍然说出来 —— 用户点完"删除"需要一个确认，而不是靠"没报错"推断。
 */
export function describeDeleteResult(result: {
  readonly deleted: number
  readonly failed: readonly ArchiveDeleteFailureItem[]
}): string {
  const head =
    result.failed.length === 0
      ? `已从归档删除 ${result.deleted} 个文件。`
      : `已从归档删除 ${result.deleted} 个文件，${result.failed.length} 个失败。`

  if (result.failed.length === 0) return head

  // 失败逐条列出来。同一个原因合并成一句，否则 200 条失败会把结果行撑成一堵墙。
  const byReason = new Map<ArchiveDeleteFailure, string[]>()
  for (const item of result.failed) {
    const label = item.name ?? '（一条已不在归档里的记录）'
    byReason.set(item.reason, [...(byReason.get(item.reason) ?? []), label])
  }

  const lines = [...byReason].map(
    ([reason, names]) =>
      `${describeDeleteFailure(reason)}：${names.slice(0, 3).join('、')}${
        names.length > 3 ? ` 等 ${names.length} 个` : ''
      }`,
  )

  return [head, ...lines].join('\n')
}
