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

import { normalizeSpellcheckLanguages } from '../shared/language'
import { normalizeTheme } from '../shared/theme'
import { normalizeZoomFactor } from '../shared/zoom'
import {
  DEFAULT_SETTINGS,
  changedRestartKeys,
  type Settings,
  type SettingsKey,
} from '../shared/types'
import { logger } from './logger'

const SETTINGS_FILE = 'settings.json'

/**
 * 已经从 `Settings` 里删掉、但用户磁盘上可能还留着的键。
 *
 * ⚠️ 留着它们**不会**改变任何行为（{@link coerce} 只认 `DEFAULT_SETTINGS` 里的键，未知键一律
 * 丢掉），但会让下一个读这个文件的人（用户自己、或排查问题时）以为它还有用 —— 而这一条恰好是
 * "设置里的东西不起作用"的另一种形状。因此加载时发现一次就记一条，并把文件写回干净的一份。
 *
 * `uiLanguage` 是 [ADR-0066] 撤掉「界面语言」时留下的：那项设置整条去掉了。
 */
const REMOVED_SETTINGS_KEYS = ['uiLanguage'] as const

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
   * **枚举型**字段在这里收敛到表内（判据在 `shared/language.ts`）。
   *
   * 上面那圈 `typeof` 比对管不住它：任何字符串都能通过，`de-DE` 也能带走。而存下一个我们不认识
   * 的值，症状是"设置里显示的是 A、实际按 B 跑" —— 用户没有任何办法看出来。因此收敛发生在
   * **读设置的那一刻**，而不是在各个消费点上各判一次（那样必然漏一处）。
   */
  const spellcheckLanguages = normalizeSpellcheckLanguages(result['spellcheckLanguages'])
  if (spellcheckLanguages !== result['spellcheckLanguages']) {
    logger.warn('settings: adjusted the spellcheck dictionaries to the known list')
  }
  result['spellcheckLanguages'] = spellcheckLanguages

  /**
   * 同一条纪律用在主题上（[ADR-0078]）：它也是枚举，任何字符串都能骗过上面那圈 `typeof`。
   * 认不出的值收敛到"跟随系统"，而不是让一个不存在的取值一路走到 `nativeTheme`。
   */
  const theme = normalizeTheme(result['theme'])
  if (theme !== result['theme']) {
    logger.warn('settings: adjusted the theme to the known list')
  }
  result['theme'] = theme

  /**
   * 缩放同一条纪律（[ADR-0079]）：它是个数字，因此 `typeof` 那圈校验放得过 `99` / `0` / `-2`
   * —— 而内核会把超范围的值**夹到它自己的边界**，症状变成"界面显示 300%、实际 500%"。
   */
  const zoomFactor = normalizeZoomFactor(result['zoomFactor'])
  if (zoomFactor !== result['zoomFactor']) {
    logger.warn('settings: adjusted the zoom factor to the nearest step', { zoomFactor })
  }
  result['zoomFactor'] = zoomFactor

  return result as unknown as Settings
}

export function loadSettings(): Settings {
  const path = settingsPath()

  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const settings = coerce(raw)

    /**
     * 磁盘上若还留着**已经删掉的键**，顺手把文件写回干净的一份（见 {@link REMOVED_SETTINGS_KEYS}）。
     *
     * 刻意只在这一处做：读设置只有启动与 `updateSettings()` 两条路，而后者本来就会落盘，
     * 于是"陈旧键"最多活到下一次成功加载。
     */
    if (typeof raw === 'object' && raw !== null) {
      const stale = REMOVED_SETTINGS_KEYS.filter((key) => key in (raw as Record<string, unknown>))

      if (stale.length > 0) {
        logger.info('settings: rewriting the file without fields of removed settings', { stale })
        saveSettings(settings)
      }
    }

    return settings
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
 * 本次运行改过、且**要重启**才生效的那些设置项（判据是纯函数
 * `shared/types.ts` 的 {@link changedRestartKeys}，因此这里只是一次取值）。
 *
 * 界面据此决定要不要给「立即重启」按钮 —— 常驻一个按钮就成了噪音，而"改完却什么都不说"
 * 会让用户以为这一项已经生效了。
 *
 * ⚠️ `RESTART_REQUIRED_SETTINGS` 现在是**空的**（[ADR-0066] 撤掉了唯一待过的成员「界面语言」），
 * 因此它现在恒返回空数组。`initial` 这份快照与判据都留着：它们与哪一项在名单里无关。
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
