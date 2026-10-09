/**
 * 密文缓存切换的人话。
 *
 * 与 `migration.ts` 同样的理由：**文案只有这一份** —— 主进程与设置页都用它，各写一份的
 * 后果是同一件事在两处措辞不同，用户会以为是两件事，或者更糟：其中一处忘了随新增的失败
 * 原因更新。
 *
 * 这里只剩"失败怎么说"。切换不再有确认框，也没有进度界面（[ADR-0028]），因此没有规模说明
 * 与进度文案可写 —— 设置页那一行的结果提示就是它全部的读者。
 */

import type { CacheSwitchFailure } from './types'

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
