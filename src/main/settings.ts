/**
 * 用户设置的读写。
 *
 * 刻意不用依赖（如 zod / conf）来做这件事：字段少、形状固定，用类型守卫够了。
 * 引入依赖的收益不足以抵消它对打包产物与供应链的影响（见 ai/CONVENTIONS.md 第 7 节）。
 *
 * 文件里**不得**出现任何凭据 —— 登录态由 Electron 的会话分区管理，两者不要混。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app } from 'electron'

import { DEFAULT_SETTINGS, type Settings } from '../shared/types'
import { logger } from './logger'

const SETTINGS_FILE = 'settings.json'

function settingsPath(): string {
  return join(app.getPath('userData'), SETTINGS_FILE)
}

/**
 * 逐字段校验。
 *
 * 读到损坏或过期的文件时**回落到默认值**而不是抛错：一个坏掉的配置文件不应该
 * 让应用完全无法启动。但要在日志里留痕，否则用户永远不知道自己的设置没生效。
 */
function coerce(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SETTINGS

  const input = raw as Record<string, unknown>
  const result: Record<string, unknown> = { ...DEFAULT_SETTINGS }

  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const value = input[key]
    if (typeof value === typeof fallback) {
      result[key] = value
    } else if (value !== undefined) {
      logger.warn('settings: type mismatch, using default', { key })
    }
  }

  return result as unknown as Settings
}

export function loadSettings(): Settings {
  const path = settingsPath()

  try {
    return coerce(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    // 首次启动时文件不存在是正常情况，不记为错误。
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('settings: unreadable, falling back to defaults', {
        reason: (error as Error).name,
      })
    }
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings: Settings): void {
  writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

/**
 * 进程内当前设置。
 *
 * 接管层通过 {@link getSettings} **每次读取**而不是在注册时接收一份快照 ——
 * 否则用户在偏好设置里改了"点击时自动打开"，要重启才生效。
 * 这类"设置改了不起作用"的问题很难被当成 bug 报出来，而是被当成设计如此。
 */
let current: Settings | null = null

export function getSettings(): Settings {
  current ??= loadSettings()
  return current
}

/** 部分更新并落盘。返回更新后的完整设置，供界面回读。 */
export function updateSettings(patch: Partial<Settings>): Settings {
  const merged = coerce({ ...getSettings(), ...patch })
  saveSettings(merged)
  current = merged
  return merged
}
