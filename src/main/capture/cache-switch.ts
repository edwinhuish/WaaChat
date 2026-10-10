/**
 * 一次"密文缓存开关"的切换：把**转换文件**、**切协议层**、**落设置**绑成一次
 * 要么全成、要么全不成的操作（[ADR-0027]）。
 *
 * 整个切换是**静默**的：没有确认框、也没有维护界面（[ADR-0028]），界面只在开关那一行
 * 显示进行态与结果。去掉的是仪式，不是确定性 —— 下面的次序与回退语义一条都没变。
 *
 * 与 `archive/relocate.ts` 守着同一条约束：文件在文件系统里、状态在 `settings.json` 里，
 * 两者没有共同的提交点，因此只能规定一个方向 —— **先转换，再落设置**，任何一边失败都把
 * 另一边撤销回去。
 *
 * 与那次不同的是这里还牵着第三个状态：**协议层挂着没有**。它必须在提交的那一刻就跟着变，
 * 否则刚清干净的缓存会被仍然挂着的那一层重新写回来（ADR-0027 背景第 1 点）。因此顺序是：
 *
 *   1. 先切协议层（停止 / 开始拦截）
 *   2. 转换文件（关闭 = 搬进暂存区，可回滚；开启 = 删掉命不中的残留）
 *   3. 落设置 —— 提交点
 *   4. 收尾（仅关闭方向）：删掉暂存区；这一步**失败不回退**，状态已经切过去了
 *
 * 任何一步失败都把前两步撤回去：搬回文件、恢复协议层的原状、设置一个字节都不写。
 *
 * 本模块需要 electron（`Session`）与协议层，因此**不进单测** —— 可测的部分都在
 * `cache-files.ts` 里（与 `relocate.ts` / `migrate.ts` 的分工一致）。
 */

import type { Session } from 'electron'

import type { Settings } from '../../shared/types'
import { failureReason } from '../errors'
import { logger } from '../logger'
import { convertCache, purgeStaging, restoreStaging, type CacheConversionPlan } from './cache-files'
import { attachCiphertextCache, detachCiphertextCache, isCiphertextCacheAttached } from './protocol'

export type CacheSwitchOutcome =
  | {
      readonly ok: true
      readonly enabled: boolean
      readonly converted: number
      readonly bytes: number
      readonly pendingCleanup: number
    }
  | {
      readonly ok: false
      readonly failure: 'write-failed'
      readonly detail: string
      readonly rolledBack: boolean
    }

/**
 * 执行一次切换。
 *
 * @param commit 把新状态写进设置并落盘。由调用方注入（这一层不该知道设置存在哪）；
 *               它**抛错即视为提交失败**，此时文件与协议层都会被恢复原状。
 */
export async function switchCiphertextCache(
  plan: CacheConversionPlan,
  ses: Session,
  getSettings: () => Settings,
  commit: () => void,
): Promise<CacheSwitchOutcome> {
  const target = plan.target

  /**
   * 协议层的原状。切换前它应当是"老状态那一侧"，但**以实际挂着没有为准** ——
   * 上一次切换失败过的话，设置与它可能还没对上，而回滚必须恢复到真实的状态。
   */
  const layerWasAttached = isCiphertextCacheAttached()

  const restoreLayer = (): void => {
    try {
      if (layerWasAttached) attachCiphertextCache(ses, getSettings)
      else detachCiphertextCache(ses)
    } catch (error) {
      // 恢复不了只记日志：设置没有提交，因此下次启动会按设置重新决定挂不挂。
      logger.error('capture: could not restore the ciphertext layer', {
        reason: failureReason(error),
      })
    }
  }

  // 1. 协议层先跟上。失败就什么都别做：文件一个没动、设置也没写。
  try {
    if (target) attachCiphertextCache(ses, getSettings)
    else detachCiphertextCache(ses)
  } catch (error) {
    const detail = failureReason(error)
    logger.error('capture: could not switch the ciphertext layer', { detail })

    return { ok: false, failure: 'write-failed', detail, rolledBack: true }
  }

  // 2. 转换文件。convertCache 自己负责失败时的回滚。
  const converted = await convertCache(plan)

  if (!converted.ok) {
    restoreLayer()

    return {
      ok: false,
      failure: 'write-failed',
      detail: converted.detail,
      rolledBack: converted.rolledBack,
    }
  }

  // 3. 落设置 —— 提交点。到这一步文件已经全部转换完，用户再也看不到"半截"。
  try {
    commit()
  } catch (error) {
    const detail = failureReason(error)
    const restored = target ? true : await restoreStaging()

    restoreLayer()
    logger.error('capture: the ciphertext switch could not be committed', {
      detail,
      restored,
    })

    return { ok: false, failure: 'write-failed', detail, rolledBack: restored }
  }

  // 4. 收尾：删掉暂存区。它失败**不**回退 —— 状态已经切过去了，剩下的只是磁盘空间。
  let pendingCleanup = 0

  if (!target) {
    pendingCleanup = await purgeStaging()
  }

  logger.info('capture: ciphertext cache switched', {
    enabled: target,
    converted: converted.converted,
    bytes: converted.bytes,
    pendingCleanup,
  })

  return {
    ok: true,
    enabled: target,
    converted: converted.converted,
    bytes: converted.bytes,
    pendingCleanup,
  }
}
