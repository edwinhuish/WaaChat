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

/**
 * 设置项之外的**额外行**。
 *
 * 它们同样是"界面上一行的身份"，但不落进 `Settings`：应用图标是"设置之外的一个动作"，
 * 「关于」是"只读的说明"，「界面语言」那一条同样是只读说明（[ADR-0066]：语言由**账号**决定，
 * 我们这一层没有可动的杠杆，因此它从设置项变成了说明文字）。单独列一个清单的理由有两条：
 *
 *   1. {@link ALL_SETTINGS_RENDERED} 只能断言"每个**设置项**都有一行"，因此多出来的行必须
 *      有一个**显式**的来源 —— 单测与离线自检据此核对总数，而不是写一个会过期的魔法数字；
 *   2. 新增一行却忘了放进区域时，总数对不上，报错能直接指出是哪个清单的问题。
 */
export const EXTRA_SETTINGS_ROWS = ['appIcon', 'about', 'languageNotice'] as const

/** 上面那个清单里的行。 */
export type ExtraSettingsRow = (typeof EXTRA_SETTINGS_ROWS)[number]

/** 界面上一行的身份：设置的每一项 + {@link EXTRA_SETTINGS_ROWS}。 */
export type SettingsRowKey = keyof Settings | ExtraSettingsRow

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
 * 然后是我们自己界面对不上的两组：只影响**内嵌页面**的语言与输入，以及桌面集成；
 * 最后是只读的说明。两项容量上限**紧跟各自管辖的开关**：
 *
 *   - 「归档大小上限」跟在「文件保存位置」后面（都在说归档占多少、在哪）；
 *   - 「密文缓存上限」跟在「密文磁盘缓存」后面（容量项离开开关就没有作用对象）。
 *
 * 「后台预取文档」放在密文缓存区域：它预取的就是密文 —— 缓存关着时这个开关没有意义，
 * 两者本来就该一起看。
 *
 * 「关于」永远在最后一行：它不是设置项，而是**只读的说明**（应用名与版本）。用户报问题时
 * 第一句总是"你用哪个版本"，而在它出现之前，界面里没有这个答案（[ADR-0056]）。
 *
 * ⚠️ **区域不能是空的**（单测与离线自检都断言"每个区域至少有一行"）：删掉某一行的同时，
 * 要把它**独占**的那个区域一起删掉。
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
    /**
     * 「语言与输入」讲的是**内嵌页面**上的两件事：它显示成什么语言、你在它里面打字时内核
     * 查不查拼写。两项都只影响被承载的页面，不改我们自己的界面 —— 因此它们不与「外观与启动」
     * 合并：那个区域的每一行都是"我们这扇应用"的事，而这两行不是。
     *
     * ⚠️ 语言那一行是**说明**而不是设置项（[ADR-0066]）：语言由**账号**决定，而入口在手机端，
     * 我们做的任何固定都会被页面改回去。它留在这一区域的最前面，是因为用户会先在这里找"怎么
     * 换语言"—— 让他看到的必须是那句实话，而不是一个按不动的下拉框。
     *
     * 词典列表**紧跟**它管辖的开关（与两个容量项同一条纪律）："英语（美国）"这一行离开
     * 「拼写检查」就读不懂 —— 那是给谁查的？
     */
    title: '语言与输入',
    rows: ['languageNotice', 'spellcheck', 'spellcheckLanguages'],
  },
  {
    /**
     * 「外观与启动」= 我们这扇应用自己的样子与它什么时候起来。
     *
     * 主题与缩放排在最前：它们是这一区域里仅有的两个"改完立刻在三扇窗口上都看得见"的项
     * （而图标与自启属于"装一次就不动"的那一类）。两者的顺序按用户扫视的习惯来 ——
     * 深浅是个人的、一眼就有偏好，而"字太小"是遇到之后才来找的。
     */
    title: '外观与启动',
    rows: ['theme', 'zoomFactor', 'appIcon', 'launchAtLogin'],
  },
  {
    title: '关于',
    rows: ['about'],
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
