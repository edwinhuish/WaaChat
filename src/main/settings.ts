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

import { normalizeSpellcheckLanguages, normalizeUiLanguage } from '../shared/language'
import {
  DEFAULT_SETTINGS,
  changedRestartKeys,
  type Settings,
  type SettingsKey,
} from '../shared/types'
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

  /**
   * 两个**枚举型**字段在同一个地方收敛到表内（判据在 `shared/language.ts`）。
   *
   * 上面那圈 `typeof` 比对管不住它们：任何字符串都能通过，`en-XX` 也能带走。而存下一个
   * 我们不认识的值，症状是"设置里显示的是 A、实际按 B 跑" —— 用户没有任何办法看出来。
   * 因此收敛发生在**读设置的那一刻**，而不是在各个消费点上各判一次（那样必然漏一处）。
   */
  const uiLanguage = normalizeUiLanguage(result['uiLanguage'])
  if (uiLanguage !== result['uiLanguage']) {
    logger.warn('settings: unknown interface language, falling back to the default')
  }
  result['uiLanguage'] = uiLanguage

  const spellcheckLanguages = normalizeSpellcheckLanguages(result['spellcheckLanguages'])
  if (spellcheckLanguages !== result['spellcheckLanguages']) {
    logger.warn('settings: adjusted the spellcheck dictionaries to the known list')
  }
  result['spellcheckLanguages'] = spellcheckLanguages

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

/**
 * **进程启动时**读到的那一份（第一次 {@link getSettings} 的取值），此后不再变。
 *
 * 它是"哪些改动还在等重启"的基准（[ADR-0064]）。刻意由主进程持有，而不是让界面在挂载时
 * 自己记一份：那样一来"我改过什么"就有了两个事实源，界面在开发模式下重载一次就会与真相脱节。
 */
let initial: Settings | null = null

export function getSettings(): Settings {
  if (current === null) {
    current = loadSettings()
    initial = current
  }

  return current
}

/**
 * 本次运行改过、但**还没生效**的那些设置项（判据在 `shared/types.ts` 的
 * {@link changedRestartKeys}，因此这里只是一次取值）。
 *
 * 界面据此决定要不要给「立即重启」按钮 —— 常驻一个按钮就成了噪音，而"改完却什么都不说"
 * 会让用户以为这一项已经生效了。
 */
export function pendingRestart(): SettingsKey[] {
  const loaded = initial ?? getSettings()

  return changedRestartKeys(loaded, getSettings())
}

/** 部分更新并落盘。返回更新后的完整设置，供界面回读。 */
export function updateSettings(patch: Partial<Settings>): Settings {
  const merged = coerce({ ...getSettings(), ...patch })
  saveSettings(merged)
  current = merged
  return merged
}
