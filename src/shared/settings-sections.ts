/**
 * 设置窗口的**区域与行序**（数据，不是渲染逻辑）。
 *
 * 放在 `shared/` 而不是视图里的理由与 `size-limit.ts` / `migration.ts` 相同：它是可以被
 * 离线断言的事实。视图负责把每一行画成什么样，而"哪些项属于同一个区域、谁挨着谁"是一种
 * **约定** —— 例如「密文缓存上限」必须与「密文磁盘缓存」在同一个区域里，因为一个容量项
 * 离开它管辖的那个开关就读不懂。约定写成数据之后，单测与 `scripts/check-capture.ts`
 * 都能直接断言它，而不是靠人去盯屏幕。
 *
 * 两条纪律：
 *
 *   1. **区域标题必须对区域里的每一行都为真** —— 否则就是分类错了，而错的分类比没有分类
 *      更糟（用户会按标题去找东西）。
 *   2. **每个设置项恰好出现一次**（编译期断言 {@link ALL_SETTINGS_RENDERED} + 单测）。
 *      漏掉一个设置项等于它在界面上消失，没人会发现。
 */

import type { Settings } from './types'

/** 界面上一行的身份：设置的每一项 + 一行不是设置的（应用图标）。 */
export type SettingsRowKey = keyof Settings | 'appIcon'

export interface SettingsSection {
  /** 区域标题（渲染成小标题）。 */
  readonly title: string
  /** 这个区域里的行，顺序即界面上的顺序。 */
  readonly rows: readonly SettingsRowKey[]
}

/**
 * 界面上的区域。
 *
 * 归档在前（那是用户自己的文件），密文缓存随后（它是为了少一次网络往返而留下的派生数据），
 * 然后是阅读方式，最后是桌面集成。两项容量上限**紧跟各自管辖的开关**：
 *
 *   - 「归档大小上限」跟在「文件保存位置」后面（都在说归档占多少、在哪）；
 *   - 「密文缓存上限」跟在「密文磁盘缓存」后面（容量项离开开关就没有作用对象）。
 *
 * 「后台预取文档」放在密文缓存区域：它预取的就是密文 —— 缓存关着时这个开关没有意义，
 * 两者本来就该一起看。
 */
export const SETTINGS_SECTIONS = [
  {
    title: '归档',
    rows: ['archiveDir', 'archiveMaxBytes', 'openOnCapture', 'wipeArchiveOnExit'],
  },
  {
    title: '密文缓存',
    rows: ['enableCiphertextCache', 'cacheMaxBytes', 'prefetch'],
  },
  {
    title: '阅读',
    rows: ['disablePdfPreview'],
  },
  {
    title: '外观与启动',
    rows: ['appIcon', 'launchAtLogin'],
  },
] as const satisfies readonly SettingsSection[]

/** 所有出现过的行（判据用）。 */
type CoveredRow = (typeof SETTINGS_SECTIONS)[number]['rows'][number]

/**
 * 编译期断言：**每个设置项都有一行**。
 *
 * 新增一个设置项却忘了把它放进某个区域时，`true` 就赋不进 `false`，编译当场失败 ——
 * 而不是"界面上少一行、几个月没人发现"。漏掉的那一项的名字会出现在类型错误里。
 */
export const ALL_SETTINGS_RENDERED: Exclude<SettingsRowKey, CoveredRow> extends never
  ? true
  : false = true

/** 扁平的显示顺序（视图与断言都用它，免得两处各自展开一遍）。 */
export const SETTINGS_ROW_ORDER: readonly SettingsRowKey[] = SETTINGS_SECTIONS.flatMap(
  (section) => [...section.rows],
)

/** 某个设置项落在哪个区域。找不到时返回 `null`（那只可能是上面那条编译期断言漏了）。 */
export function sectionOfRow(key: SettingsRowKey): SettingsSection | null {
  return SETTINGS_SECTIONS.find((section) => section.rows.some((row) => row === key)) ?? null
}
