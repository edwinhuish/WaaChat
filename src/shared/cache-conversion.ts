/**
 * 密文缓存切换的人话。
 *
 * 与 `migration.ts` 同样的理由：主进程要用它填确认框与错误对话框，维护界面要用它填
 * 状态行。**文案只有这一份** —— 各写一份的后果是同一件事在两处措辞不同，用户会以为
 * 是两件事，或者更糟：其中一处忘了随新增的失败原因更新。
 */

import { formatBytes } from './format'
import type { CacheConversionProgress, CacheSwitchFailure } from './types'

/**
 * 把切换失败的原因翻译成用户能理解的一句话。
 *
 * 末尾的 `never` 断言不是装饰：新增一种失败原因时**编译会失败**，从而强制补上翻译。
 */
export function describeCacheSwitchFailure(failure: CacheSwitchFailure, detail: string): string {
  switch (failure) {
    case 'busy':
      return '正在切换密文磁盘缓存，请等这一次切换完成。'
    case 'unreadable':
      return `读不到缓存目录（${detail}）。请检查它的权限，或先手工把它删掉。`
    case 'write-failed':
      return `转换缓存文件时失败（${detail}）。磁盘可能已满，或该目录不可写。`
    default: {
      const unhandled: never = failure
      return `切换出现未知错误（${String(unhandled)}）。`
    }
  }
}

/** 维护界面那行进度文案：「正在转换缓存文件 12/40（30%）」。 */
export function describeCacheConversionProgress(progress: CacheConversionProgress): string {
  switch (progress.phase) {
    case 'converting': {
      // 分母来自"动手之前算的计划"，分子来自执行。开启方向可能因为并发写入而对不上，
      // 因此上限夹到 100 —— 让用户看到"105%"只会让他怀疑这个界面。
      const percent =
        progress.total === 0
          ? 100
          : Math.min(100, Math.round((progress.done / progress.total) * 100))
      return `正在转换缓存文件 ${progress.done}/${progress.total}（${percent}%）`
    }
    case 'committing':
      return '正在写入设置…'
    case 'cleaning':
      return '正在清理暂存区…'
    default: {
      const unhandled: never = progress.phase
      return `正在处理…（${String(unhandled)}）`
    }
  }
}

/**
 * 确认框里的规模说明。
 *
 * 两个方向的后果完全不同，因此文案也分开写：关闭是**删除**（缓存没了，下次打开要重新
 * 下载），开启只是**清掉命不中的残留**（已有的缓存保留）。把两者写成同一句会让用户
 * 以为"开启"也会清缓存。
 */
export function describeCacheSwitchScope(target: boolean, entries: number, bytes: number): string {
  if (entries === 0) {
    return target ? '当前没有需要处理的残留文件。' : '当前没有缓存文件需要清除。'
  }

  return target
    ? `将清掉 ${entries} 个文件（${formatBytes(bytes)}）—— 那是正文与元信息缺一半、永远命不中的残留。已有的缓存会保留。`
    : `将清除 ${entries} 个缓存文件（${formatBytes(bytes)}）。它们是纯派生数据，删掉只影响速度，下次打开会重新下载。`
}
