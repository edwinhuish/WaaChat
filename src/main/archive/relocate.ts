/**
 * 更换归档位置：把"搬数据"和"落设置"绑成一次要么全成、要么全不成的操作。
 *
 * 这一步之所以要单独一个模块，是因为它守着一条**跨两个存储**的约束：
 * 文件在**文件系统**里，位置在 `settings.json` 里，两者没有共同的提交点。于是只能
 * 规定一个方向：**先搬数据，再落设置**。任何一边失败，都把另一边撤销回去。
 *
 *   数据搬完 → 设置落盘失败 → 数据搬回原位（否则重启后应用回到旧目录，而用户会
 *                              看到"归档凭空清空"）
 *   数据搬一半 → 迁移本身就失败 → 已搬走的搬回原位（见 migrate.ts）
 *
 * 反过来的顺序（先落设置再搬数据）会让失败窗口更大：设置指向新位置、数据还在旧位置，
 * 而"回滚设置"同样要写盘 —— 一次磁盘满就会把用户卡在中间状态。
 *
 * 本模块导入 store.ts（要断索引、要切目录），因此**不进单测** ——
 * 可被测的部分都在 migrate.ts 里。
 */

import type {
  ArchiveMigrationProgress,
  MigrationFailure,
  MigrationSummary,
} from '../../shared/types'
import { logger, redactPath } from '../logger'
import { failureReason, migrateArchive, rollbackMigration, type MigrationPlan } from './migrate'
import { applyArchiveDir, closeArchiveStore } from './store'

export type RelocationOutcome =
  | { readonly ok: true; readonly target: string; readonly migrated: MigrationSummary }
  | {
      readonly ok: false
      readonly failure: MigrationFailure
      readonly detail: string
      readonly rolledBack: boolean
    }

/**
 * 执行一次完整的"换位置"。
 *
 * @param commit 把新位置写进设置并落盘。由调用方注入，因为这一层不该知道设置存在哪；
 *               它**抛错即视为提交失败**，此时数据会被搬回原位。
 */
export async function relocateArchive(
  plan: MigrationPlan,
  onProgress: (progress: ArchiveMigrationProgress) => void,
  commit: () => void,
): Promise<RelocationOutcome> {
  /**
   * 索引连接必须先断开。WAL 模式下可能还有没 checkpoint 的改动，不关连接就搬走的
   * 是半个库 —— 表现为"迁移后归档界面里少了一部分记录"，而且原因极难归因。
   */
  closeArchiveStore()

  const moved = await migrateArchive(plan, onProgress)
  if (!moved.ok) {
    logger.warn('archive: relocation aborted', {
      failure: moved.failure,
      rolledBack: moved.rolledBack,
    })
    return moved
  }

  try {
    commit()
  } catch (error) {
    // 数据已经在新位置，但设置没落盘 —— 必须把数据搬回去，否则重启后两者对不上。
    const restored = await rollbackMigration(plan)
    logger.error('archive: relocation could not be committed', {
      rolledBack: restored,
      reason: failureReason(error),
    })

    return {
      ok: false,
      failure: 'write-failed',
      detail: failureReason(error),
      rolledBack: restored,
    }
  }

  /**
   * 设置已经落盘，这时才切换进程内的目录。
   *
   * `applyArchiveDir` 会重新建目录（顺带把权限收紧到 0700 —— 新位置可能是用户
   * 自己建的 0755 目录）并按新路径重开索引连接。
   */
  applyArchiveDir(plan.target)

  logger.info('archive: relocated', {
    files: plan.summary.files,
    bytes: plan.summary.bytes,
    to: redactPath(plan.target),
  })

  return { ok: true, target: plan.target, migrated: plan.summary }
}
