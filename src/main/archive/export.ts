/**
 * 批量导出：把归档正文**复制**到用户选的目录（[ADR-0050]）。
 *
 * 与迁移（`migrate.ts`）的区别是根本性的：迁移**搬**我们自己的库（因此有回滚、有计划、
 * 有"目标必须为空"），导出只是往用户的目录里**写副本** —— 归档那边一个字节都不动。
 * 因此这里没有回滚可言，只有"逐条报告成败"。
 *
 * 三件前置判断留在调用方（它们都需要主进程才知道的东西）：目录由**对话框**挑、
 * 目标是否落在归档里（{@link isInsideArchive}）、条数是否超限。
 */

import { constants, existsSync } from 'node:fs'
import { chmod, copyFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { ArchiveExportFailureItem, ArchiveRecord } from '../../shared/types'
import { logger } from '../logger'
import { archiveFilePath } from './blobs'
import { pickExportName } from './naming'

/**
 * 一次最多导出多少条（[ADR-0050] 决定 8）。
 *
 * 列表窗口一页 100 条，因此这个数字**只挡异常 payload**，不挡正常使用。
 */
export const EXPORT_MAX_ITEMS = 200

/**
 * 导出副本的权限：可写的普通文件（[ADR-0050] 决定 5）。
 *
 * 必须显式改回来：`copyFile` 会把归档那份的只读模式一起带过去（[ADR-0031]），而只读是
 * **归档的内部纪律**（防误改、防"打开一次就变样"）。用户拿到的副本是他自己的文件 ——
 * 要能改名、能编辑、能再转发给同事。
 */
const EXPORT_FILE_MODE = 0o644

/**
 * 目标目录是否落在归档目录**里面**（含"就是它"）。
 *
 * 只挡"里"这一个方向：导出到归档的**上级**（例如 `~/Documents`，归档就在它下面）完全正常，
 * 那也是文件对话框最常见的落点。迁移那边要连上级一起挡，是因为"搬进自己的父目录"等于没搬
 * （`isAllowedTarget()`）—— 那条理由在这里不存在。
 *
 * 理由本身：往归档里写"不是我们放进去的文件"，会被淘汰纪律原样放过（[ADR-0048] 只删索引
 * 认识的东西）⇒ 它们永久占着磁盘、谁都不认领，而占用统计还把它们算进"归档占用"。
 *
 * 纯字符串比较（两边都补上结尾的 `/`，否则 `/a/bc` 会被误判成 `/a/b` 的子目录），因此
 * `scripts/check-capture.ts` 能离线断言它。调用方负责先把两边过一遍 `realpath` ——
 * 否则一条指向归档内部的符号链接能绕过去。
 */
export function isInsideArchive(target: string, archive: string): boolean {
  if (target === '' || archive === '') return false
  if (target === archive) return true

  const prefix = archive.endsWith('/') ? archive : `${archive}/`
  return target.startsWith(prefix)
}

export interface ExportSummary {
  readonly exported: number
  readonly failed: readonly ArchiveExportFailureItem[]
}

/**
 * 把记录逐条复制到 `target`。
 *
 * 顺序与判据：
 *   1. 正文不在（被容量淘汰、或用户手工删过）⇒ 逐条报 `missing`。**不静默跳过** ——
 *      跳过会让"N 个成功"变成谎话，而用户是按自己选了几条来对账的；
 *   2. 挑一个不冲突的名字，挑不出来 ⇒ 报 `name-taken`；
 *   3. 复制 + 改回可写。任何一步失败 ⇒ 报 `write-failed`，**继续处理后面的条目**
 *      （一条读不了不该让整批停下）。
 *
 * 目标目录读不了（不存在、不是目录）会**抛错**，由调用方翻译成 `target-unusable`：
 * 那时一个文件都还没写，属于"整次调用被拒绝"，与逐条失败不是一回事。
 */
export async function exportRecords(
  records: readonly ArchiveRecord[],
  target: string,
): Promise<ExportSummary> {
  /**
   * 目标目录里已占用的名字，一次 `readdir` 取齐：逐条 `existsSync` 是 N 次系统调用，而且
   * 同一批里的两个同名记录会撞到同一个名字上 —— 复制成功一个就往里加一个。
   */
  const taken = new Set(await readdir(target))

  const failed: ArchiveExportFailureItem[] = []
  let exported = 0

  for (const record of records) {
    const source = archiveFilePath(record.storedName)

    if (!existsSync(source)) {
      failed.push({ name: record.name, reason: 'missing' })
      continue
    }

    const name = pickExportName(taken, record.name, record.hash)
    if (name === null) {
      failed.push({ name: record.name, reason: 'name-taken' })
      continue
    }

    const destination = join(target, name)

    try {
      /**
       * `COPYFILE_EXCL`：挑名字与写文件之间存在窗口（另一个程序、或用户自己刚放进去一个
       * 同名文件）。"存在就覆盖"会把那份文件盖掉 —— **不可逆**；`EXCL` 让这次竞态变成
       * 一条可见的失败（[ADR-0050] 决定 6）。
       */
      await copyFile(source, destination, constants.COPYFILE_EXCL)
      await chmod(destination, EXPORT_FILE_MODE)

      taken.add(name)
      exported += 1
    } catch (error) {
      // 只记原因类型：错误消息里可能带**完整路径与文件名**（INVARIANTS G-3）。
      logger.warn('archive: export failed', { reason: (error as Error).name })
      failed.push({ name: record.name, reason: 'write-failed' })
    }
  }

  logger.info('archive: export finished', { exported, failed: failed.length })

  return { exported, failed }
}
