/**
 * 接管的健康状态。
 *
 * 这个模块存在的唯一理由：**接管失效必须可见**。
 *
 * 失败模式里最糟的一种不是报错，而是安静地退回上游的原生行为 —— 文件下载到
 * `~/Downloads`，应用什么也不说，用户以为是自己操作错了，然后去文件夹里翻，
 * 而这恰好是本项目要消灭的行为。所以状态要能被界面读到、被日志记录。
 *
 * 见 docs/architecture.md 第 5 节。
 */

import type { CaptureFailure, CaptureHealth } from '../../shared/types'

let lastCaptureAt: number | null = null
let lastError: CaptureFailure | null = null

type Listener = (health: CaptureHealth) => void
const listeners = new Set<Listener>()

function snapshot(): CaptureHealth {
  return { lastCaptureAt, lastError }
}

function publish(): void {
  const health = snapshot()
  for (const listener of listeners) listener(health)
}

/** 一次成功的"下载 → 归档 → 打开"。 */
export function markCaptured(at: number = Date.now()): void {
  lastCaptureAt = at
  lastError = null
  publish()
}

/** 一次可预期的失败。会把状态推给界面。 */
export function markFailure(failure: CaptureFailure): void {
  lastError = failure
  publish()
}

/** 订阅变化。返回取消订阅函数。 */
export function onHealthChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
