/**
 * 批量删除：把用户在文件列表里选中的记录**从归档里去掉**（[ADR-0053]）。
 *
 * 与 `export.ts` 是镜像关系：导出往用户的目录里**写副本**（归档一个字节都不动），删除把归档
 * 里的**那一份去掉**。两者都只在"逐条报告成败"这一层：一条处理不掉不该让整批停下。
 *
 * ── 与淘汰的区别（不要合并这两件事）──
 *
 * | | 淘汰（`store.enforceLimit()`） | 删除（这里） |
 * |---|---|---|
 * | 粒度 | **内容**：一个哈希下的全部磁盘名 | **记录**：用户选中的那一行指着的那**一个**名字 |
 * | 目的 | 腾出字节 | "我不想要它了" |
 * | 触发 | 超过大小上限，按最久未访问优先 | 用户点了「删除…」并确认 |
 *
 * 同一份内容被多条消息引用时（[ADR-0052] 的硬链接），删掉一条**不释放任何字节**，而另外那些
 * 名字属于**用户没选的别的行**，必须原样留着 —— 顺手多删就是删别人的数据。
 *
 * ── 依赖以回调注入 ──
 *
 * `removeFile` / `forget` / `pruneFolders` 由调用方给（生产环境是 `blobs.removeStoredFile()`、
 * `store.deleteById()` 与 `blobs.pruneEmptyFolders()`）。因此这一层既不碰文件系统也不碰数据库，
 * 能被单测直接断言那条**配对规则**：文件删掉了才删索引记录。
 */

import type { ArchiveDeleteFailureItem, ArchiveRecord } from '../../shared/types'
import { logger } from '../logger'

/**
 * 一次最多删多少条。
 *
 * 与导出的上限同一个数（[ADR-0050] 决定 8 / [ADR-0053]）：列表一页 100 条，这条只挡异常
 * payload，不挡正常使用。
 */
export const DELETE_MAX_ITEMS = 200

export interface DeleteSummary {
  /** 真正删掉的记录条数。 */
  readonly deleted: number
  readonly failed: readonly ArchiveDeleteFailureItem[]
}

/**
 * 逐条删除：**先删磁盘上的名字，成功了才删索引记录**。
 *
 * 顺序不是风格问题，而是这条不变量本身：
 *
 *   - **先文件、后记录**：文件删不掉时记录**保留** ⇒ 用户重试一次即可，归档仍然自洽。
 *   - **若反过来**（先删记录）：文件删不掉就留下一份"没有索引指向的正文" —— 它不在索引里，
 *     因此不会被淘汰（[ADR-0048] 只删索引认识的东西），也不会再被任何人看见，而用户以为
 *     已经删掉了。
 *
 * 一条失败**不影响后面的条目**：删除是用户的批量意图，一条被占用不该让另外 19 条也留下。
 *
 * @param records 已经解析好的记录（调用方负责把不存在的 id 译成 `missing`）。
 * @param removeFile 删掉一个磁盘名。`true` = 它现在不在磁盘上了（删掉了或本来就不在）。
 * @param forget 删掉一条索引记录。`false` = 它已经不在（被淘汰、或另一次删除带走）。
 * @param pruneFolders 收掉这条正文删掉之后**空掉的那几层容器目录**（[ADR-0054]）。
 */
export function deleteRecords(
  records: readonly ArchiveRecord[],
  removeFile: (storedName: string) => boolean,
  forget: (id: number) => boolean,
  pruneFolders: (storedName: string) => void,
): DeleteSummary {
  const failed: ArchiveDeleteFailureItem[] = []
  let deleted = 0

  for (const record of records) {
    if (!removeFile(record.storedName)) {
      failed.push({ name: record.name, reason: 'remove-failed' })
      continue
    }

    /**
     * 名字从磁盘上消失之后，它所在的那一层可能已经空了（[ADR-0054]）—— 顺手收掉，不在用户的
     * 归档目录里留一串既解释不了也点不开的空壳。
     *
     * 位置在 `forget()` **之前**、且不看它的结果，因为这属于**善后**而不是结果：文件确实
     * 已经不在了，空容器就该收；索引那一侧成不成功、这一条最后算不算"删掉了"，都与它无关。
     * 删不掉的那条（上面 `continue`）走不到这里 —— 磁盘上那份还在，容器当然不空。
     */
    pruneFolders(record.storedName)

    if (!forget(record.id)) {
      /**
       * 文件已经不在了（或本来就不在），而记录也没了 —— 说明它在这一瞬间被别的路径（淘汰、
       * 另一次删除）带走了。**目标状态其实已经达成**，但索引那一侧不是我们做成的，仍然报出来：
       * 把"别人干的"说成"我删掉了"会让用户在出错时找错方向。
       */
      failed.push({ name: record.name, reason: 'remove-failed' })
      continue
    }

    deleted += 1
  }

  // 只记数量：文件名来自对端发送者（INVARIANTS G-3）。
  logger.info('archive: delete finished', { deleted, failed: failed.length })

  return { deleted, failed }
}
