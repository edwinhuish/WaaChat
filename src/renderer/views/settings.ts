/**
 * 偏好设置。
 *
 * 三条原则：
 *
 *  1. **改动即时生效，不设「保存」按钮。** 每个开关独立提交，回填主进程返回的
 *     完整设置 —— 界面显示的就是实际生效的，不存在"我改了但它没生效"这种模糊状态。
 *  2. **没实现的项不假装能用，但状态要说的是"你当前的配置"。** 今天没有实现的是
 *     「后台预取文档」这一个开关（见 `docs/roadmap.md` M4 的候选），因此它渲染成**禁用的**
 *     控件；两项容量上限都已经真的会被执行（[ADR-0048] / [ADR-0049]），于是它们是可改的。
 *     禁用与否只能由"这一项今天是否真的会被执行"决定 —— `SIZE_LIMIT_ENFORCED`（容量项）与
 *     `ToggleSpec.enforced`（开关）是同一个事实的两个落点。一个能改但不起作用的开关，比一个
 *     明确标注"尚未生效"的开关糟得多，前者会让用户相信一件不成立的事。但状态本身也不该是
 *     一句写死的话：**"不限制"时没有失效可言**（字面意思就是不清理），只有"设了上限却不会
 *     被执行"才需要警告。因此容量项的状态由 `describeSizeLimit()` 按"当前值 + 今天是否真的
 *     执行"算出来，而不是写在这一行里 —— 功能落地时改一个布尔值就够，不会留下一句过期的话。
 *  3. **相关的项放在同一个区域，且区域标题必须对里面的每一行都为真。**
 *     区域与行序是数据（`shared/settings-sections.ts`），不是散在这一篇渲染代码里的分支：
 *     两项容量上限因此必然紧跟各自管辖的开关 —— 一个容量项离开开关就读不懂（"2 GB"是给
 *     谁设的上限？）。写成数据也意味着这条约定能被单测与离线自检断言。
 *  4. **长任务要有过程。** 换保存位置会真的搬动整个归档库，因此它有确认框（主进程）、
 *     进度、成功与失败三种可见的结果 —— 用户不该对着一个没有反应的开关猜发生了什么。
 *     密文缓存的切换走另一条路（[ADR-0028]）：它只是同目录内的搬运与删除，没有确认框、
 *     也没有进度屏；开关行在转换期间禁用自己，结束后给出一行结果。
 *  5. **图标要如实说明生效范围。** Linux 下"应用图标"有三个落点，生效时机各不相同
 *     （窗口与托盘立即生效，启动器 / 任务栏要等桌面刷新）。含糊其辞会让 Wayland 用户
 *     以为功能坏了 —— 理由与取舍见 ADR-0022。
 */

import { actionButtonAttrs } from '../../shared/action-button'
import { describeIconFailure } from '../../shared/appicon'
import { describeCacheSwitchFailure } from '../../shared/cache-conversion'
import {
  dictionaryKey,
  type DictionaryStatus,
  type DictionaryStatusMap,
} from '../../shared/dictionary-status'
import {
  SPELLCHECK_LANGUAGES,
  ensureEnabledDictionary,
  formatDictionaryList,
  moveDictionary,
  parseDictionaryList,
  stepDictionary,
  type SpellcheckEntry,
} from '../../shared/language'
import { describeMigrationFailure, describeMigrationProgress } from '../../shared/migration'
import { SETTINGS_SECTIONS, type SettingsRowKey } from '../../shared/settings-sections'
import {
  SIZE_LIMIT_ENFORCED,
  describeSizeLimit,
  sizeLimitBytesFromInput,
  type SizeLimitKey,
} from '../../shared/size-limit'
import { THEME_OPTIONS, type ThemeSource } from '../../shared/theme'
import { ZOOM_OPTIONS } from '../../shared/zoom'
import {
  RESTART_REQUIRED_SETTINGS,
  type AppIconState,
  type ArchiveMigrationProgress,
  type CacheSwitchFailure,
  type CacheSwitchResult,
  type MigrationFailure,
  type RestartState,
  type Settings,
} from '../../shared/types'
import type { InstanceInfo } from '../../shared/bridge'
import { APP_DISPLAY_NAME } from '../../shared/constants'
import { bridge } from '../bridge'
import { clear, h } from '../dom'
import { cropToAppIcon } from '../icon'

/** 只挑出 `Settings` 里的布尔字段，新增布尔项时编译器会在这里报错提醒补描述。 */
type BooleanKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings]

interface ToggleSpec {
  readonly key: BooleanKey
  readonly label: string
  readonly hint: string
  /**
   * 这一项**今天是否真的会被执行**。省略即 `true`。
   *
   * `false` ⇒ 复选框禁用并写明未实现 —— 与两个容量项同一条纪律（本文件开头第 2 条）：
   * 一个能改却不起作用的开关会让用户相信一件不成立的事。
   */
  readonly enforced?: boolean
  /**
   * 这一项对应的系统条目是**全机一份**的，因此只有默认实例能设（多实例，[ADR-0062]）。
   *
   * 命名实例里这一行会被禁用并写明原因。它**不是** `enforced: false`（那是"还没实现"）：
   * 功能是实现了的，只是归属不是这个实例。
   */
  readonly defaultInstanceOnly?: boolean
}

const TOGGLES: readonly ToggleSpec[] = [
  {
    key: 'openOnCapture',
    label: '点击文件时自动打开',
    hint: '关闭后只归档，你需要到「归档」里自己打开。',
  },
  {
    key: 'enableCiphertextCache',
    label: '密文磁盘缓存',
    /**
     * **刻意空着**（[ADR-0040]）：这一行只留开关。它的状态由复选框自己表达，
     * 转换过程与结果由 {@link cacheSwitchResultNodes} 在**刚发生的那一刻**说明 ——
     * 那比一段常驻的描述更准，也更省地方。
     *
     * ⚠️ "关闭会清掉已有缓存"这条**披露没有消失**，只是挪了位置：关闭方向的结果行里就写着
     * "已关闭：N 个缓存文件已清掉"，`docs/usage.md` 也写着。要动这段代码前先读 [ADR-0040]
     * 的"已知限制"——事前提示被去掉是那次决定的代价，不是可以顺手再补一句话的地方。
     */
    hint: '',
  },
  {
    key: 'prefetch',
    label: '后台预取文档',
    /**
     * 唯一一个"还没有实现"的设置项：`Settings.prefetch` 至今**没有任何读者**，拨动它只会
     * 让一个值变掉。因此它按第 2 条纪律禁用 —— 留这一行是为了说清"将来会有这个开关"，而
     * 不是让用户现在就以为它在工作。里程碑不写在这里：路线图把它列在 M4 的**候选**里
     * （未承诺），写死一个期号只会变成下一句过期的话。
     */
    hint: '收到文件类消息时提前拉取密文，点开更快。尚未实现（见 docs/roadmap.md 的 M4 候选）。',
    enforced: false,
  },
  {
    key: 'wipeArchiveOnExit',
    label: '退出时清除归档',
    hint: '共享机器上建议开启。只清归档，不影响登录态。',
  },
  {
    key: 'launchAtLogin',
    label: '开机自启',
    hint: '登录桌面后自动启动并保持连接，这样通知不会漏掉。',
    /**
     * 自启条目在 `~/.config/autostart/` 下是**全机一份**的，两个实例会争抢同一个文件，
     * 而 Electron 不给我们指定条目名字的能力 —— 因此归属默认实例（见 `integration/login.ts`）。
     */
    defaultInstanceOnly: true,
  },
  {
    key: 'spellcheck',
    /**
     * 这一行**真的有作用**（因此不设 `enforced: false`）：它直接接到会话的
     * `setSpellCheckerEnabled`，关掉之后内核不再标注任何词 —— 而关掉它同时也是
     * "不要从第三方下载词典"的唯一开关（默认的词典下载源是 Google 托管的 CDN，
     * 见 `docs/security.md`）。
     */
    label: '拼写检查',
    hint: '在消息输入框里标注拼错的词（内核自带，不往页面注入任何东西）。关掉后也不会去下载词典。',
  },
  {
    key: 'smoothScrolling',
    /**
     * ⚠️ 这一行是"重启后生效"名单里**唯一**的成员（[ADR-0081]）：它是一个启动期的内核开关
     * （`--disable-smooth-scrolling`），进程起来之后改不动 —— 徽标与「立即重启」那条提示
     * 都由 {@link RESTART_REQUIRED_SETTINGS} 自动给出，因此**不要**在这里另写一句"要重启"。
     */
    label: '平滑滚动',
    hint: '聊天列表滚动时的缓动。关掉它滚动会立刻跟手（内核默认开启）。',
  },
]

interface SizeSpec {
  readonly key: SizeLimitKey
  readonly label: string
}

/**
 * 两项容量上限。提示文本**不**写在这里 —— 它由 `describeSizeLimit()` 按当前值算出来
 * （见文件头第 2 条与 `shared/size-limit.ts`）。
 */
const SIZES: readonly SizeSpec[] = [
  { key: 'archiveMaxBytes', label: '归档大小上限' },
  { key: 'cacheMaxBytes', label: '密文缓存上限' },
]

/**
 * 词典进度条悬停时的那句话（[ADR-0071]）。
 *
 * 为什么要它：那条进度条靠**颜色与动效**表达状态（一段在走的蓝 / 走满的蓝 / 走满的红 / 空槽，
 * 见 [ADR-0074]），但 `unknown` 与 `failed` 从条本身读不出来（空槽与"还没消息"长得一样）
 * —— 因此还要一句话把差别说清（尤其是这两态**都不是**"正在下载"）。
 */
const DICTIONARY_STATUS_TITLES: Readonly<Record<DictionaryStatus, string>> = {
  unknown: '还没有这一门词典的下载消息（磁盘上本来就有它时，内核会直接装载而不下载）',
  downloading: '正在从下载源取这一门词典',
  ready: '这一门词典已经装好，拼写检查会用它',
  failed: '这一门词典没能从下载源取回来，这门语言的拼写不会被标注',
}

/**
 * 行的身份。区域与顺序**不在这里** —— 它们是数据（`shared/settings-sections.ts`），
 * 因为"哪些项该在一起"这种约定要能被离线断言，而不是靠人盯屏幕。
 */
type RowKey = SettingsRowKey

/**
 * 保存位置这一行的状态。
 *
 * 四种状态而不是一句会互相覆盖的提示：用户要能分辨"正在搬"、"搬成了"、
 * "没搬成但一切照旧"、"没搬成而且需要人工核对"—— 最后一种最不能含糊。
 */
type LocationState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly progress: ArchiveMigrationProgress }
  | { readonly kind: 'done'; readonly target: string; readonly files: number }
  | {
      readonly kind: 'failed'
      readonly failure: MigrationFailure
      readonly detail: string
      readonly rolledBack: boolean
    }

/**
 * 图标那一行的状态。
 *
 * 与保存位置一样分几态：成功与失败必须分得开 —— "失败时保留原图标"意味着失败时预览
 * 必须**不动**，而不是先变再变回来。
 */
type IconState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'failed'; readonly text: string }

/**
 * 密文缓存的切换状态（[ADR-0027] / [ADR-0028]）。
 *
 * 它是**一行**的状态，不是一屏：转换在后台进行，界面只在这一行上显示"正在转换"与结果，
 * 别的东西照常可点。
 */
type CacheSwitchState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running'
      /** 用户拨向的那一边。用于结果行里的措辞（开启方向失败与关闭方向失败说的不是一回事）。 */
      readonly target: boolean
    }
  | {
      readonly kind: 'done'
      readonly enabled: boolean
      readonly converted: number
      readonly pendingCleanup: number
    }
  | {
      readonly kind: 'failed'
      readonly target: boolean
      readonly failure: CacheSwitchFailure
      readonly detail: string
      readonly rolledBack: boolean
    }

export interface SettingsView {
  refresh(): Promise<void>
  /** 取消订阅迁移进度。窗口真正卸载时调用。 */
  dispose(): void
}

export function mountSettingsView(root: HTMLElement): SettingsView {
  let settings: Settings | null = null
  /**
   * 应用版本（「关于」那一行）。
   *
   * 取不到时保持 `null`，那一行显示一个破折号 —— 见 {@link aboutRow} 里那段理由。
   */
  let appVersion: string | null = null
  /**
   * 当前实例（多实例，[ADR-0062]）。
   *
   * 取不到时保持 `null`，此时「关于」显示应用名、`defaultInstanceOnly` 的项**不禁用** ——
   * 一次元数据读取失败不该让用户连开关都动不了。
   */
  let instanceInfo: InstanceInfo | null = null
  let location: LocationState = { kind: 'idle' }
  let appIcon: AppIconState | null = null
  let icon: IconState = { kind: 'idle' }
  let cacheSwitch: CacheSwitchState = { kind: 'idle' }

  /**
   * 「有改动还没生效」的状态（[ADR-0064]）。
   *
   * 取不到时按"没有"处理：那只是少一条提示，而反过来会把一颗按下去就重启应用的按钮摆在一个
   * 我们并不确定的判断上。
   */
  let restartState: RestartState = { restart: [] }

  /**
   * 每一门拼写词典的下载状态（[ADR-0071]）。
   *
   * 事实源在**主进程**（只有它订阅得到内核的事件），这里只保存最近一次的整张快照：
   * 挂载时通过 `getDictionaryStatuses()` 读一次，之后由 `onDictionaryStatusChange` 推着更新。
   *
   * 取不到的时刻按 `{}` 处理 —— 那只是"这一格暂时没有状态可说"（`unknown`），而不是失败；
   * 让整扇设置窗口因为一条进度读不到而空掉，比少画一条进度条糟得多。
   */
  let dictionaryStatuses: DictionaryStatusMap = {}

  /**
   * 「拼写检查的词典」那个选择对话框，`null` = 没开（[ADR-0069]）。
   *
   * ⚠️ 它**必须留在这里**，不能挂在行元素上：`patch()` 之后 `render()` 会把 `root` 的子树
   * 整个换掉，状态挂在元素上就会随之消失。对话框元素本身则挂在 `document.body` 上（见
   * {@link openLanguageDialog}）—— 那样它才活得过任意次重画。
   */
  let languageDialog: HTMLDialogElement | null = null

  /**
   * 当前打开的 `⋯` 菜单（[ADR-0070]）；`null` = 没开。
   *
   * ⚠️ 与 {@link languageDialog} **不同**：对话框挂在 `document.body` 上、要活过任意次重画，
   * 而这个菜单挂在**行元素里面**（行是它的定位参照），`render()` 一换子树它就没了 —— 因此
   * 状态与那两条 `document` 监听器必须在 `render()` 里一起收掉（见 {@link closeLanguageMenu}）。
   */
  let languageMenu: HTMLElement | null = null

  /**
   * 正在被拖动的那一门与它所在的行（`null` = 没在拖），[ADR-0087]。
   *
   * 拖动是**浏览器自己的**状态：`draggable` 的那个元素一旦离开文档，这次拖动就结束了。因此
   * `render()`（它会把 `root` 的子树整个换掉）也要把这两处清掉 —— 否则下一次 `dragover` 会拿一个
   * 已经不在屏幕上的行去算落点。清的理由与 `⋯` 菜单完全相同（见 {@link languageMenu}）。
   *
   * 被拖的是**语言码**而不是元素引用：拖动中间可能来一次重画（下载状态推送），而重画之后
   * 屏幕上的行已经换了一批节点，认码才不会认错。
   */
  let draggedLanguage: string | null = null
  let draggedLanguageRow: HTMLElement | null = null

  /** 拖动经过时算出来的落点（`null` = 还没落到任何一行上）。 */
  let dropLanguageRow: HTMLElement | null = null
  let dropLanguageAfter = false

  /** 读待生效状态。失败退化为"没有"（见 {@link restartState} 的说明）。 */
  async function readRestartState(): Promise<RestartState> {
    return bridge()
      .getRestartState()
      .catch(() => ({ restart: [] }))
  }

  /**
   * 刚裁剪出来、主进程还没确认的那张图的预览。
   *
   * 它让"实时预览"成为可能：用户选完图立刻看到结果，而不是先等一次 IPC 往返。
   * 主进程确认后清空，改由 `appIcon.preview` 作为唯一来源。
   */
  let iconPreview: string | null = null

  /** 提交一次部分更新，并把返回的完整设置重新渲染。 */
  async function patch(change: Partial<Settings>): Promise<void> {
    settings = await bridge().setSettings(change)

    /**
     * 紧接着重读待生效状态：改一个"要重启"的项正是那条提示**唯一**会出现（或消失）的途径，
     * 而判据在主进程（"进程启动时读到的是什么"）。留在这里不问，界面就会一直显示改动之前
     * 的状态 —— 而那正是"改完没人告诉你要重启"这一种静默失效。
     */
    restartState = await readRestartState()
    render()
  }

  function render(): void {
    if (settings === null) return

    /**
     * ⚠️ 先收掉 `⋯` 菜单：它挂在行元素里面，下面这一句会把整棵子树换掉 —— 元素跟着消失，
     * 但**状态与那两条 `document` 监听器不会自己消失**（[ADR-0070]）。
     *
     * 拖着的那一行同理（[ADR-0087]）：换了一批节点之后，那次拖动其实已经被浏览器取消了，而
     * 我们这边记着的语言码与行引用还停留在旧树上 —— 下一次 `dragover` 会拿它算出一个不存在的落点。
     */
    closeLanguageMenu()
    finishLanguageDrag()

    const current = settings
    const restartNotice = pendingRestartRow()

    /**
     * 每个区域画成 `<section>` + 一个小标题。
     *
     * 区域不是装饰：容量上限离开它管辖的开关就读不懂（"2 GB"是给谁设的上限？），而小标题
     * 是用户扫视时的锚点。区域与行序都来自 `shared/settings-sections.ts`。
     */
    root.replaceChildren(
      // 「待生效」那一条在最前面：它是一句要用户做事的提示，埋在最后等于没说。
      ...(restartNotice === null ? [] : [restartNotice]),
      ...SETTINGS_SECTIONS.map((section) =>
        h(
          'section',
          { class: 'group' },
          h('h2', { class: 'group-title', text: section.title }),
          ...section.rows.map((key) => rowFor(key, current)),
        ),
      ),
    )
  }

  /**
   * 按 {@link ROW_ORDER} 里的一行身份取它的元素。
   *
   * 分派写成显式查表而不是 if 链：新增设置项时只改顺序表与这份分派，两边不一致会立刻
   * 抛错（静默少渲染一行是这类代码里最容易被忽略的坏结果）。
   */
  function rowFor(key: RowKey, current: Settings): HTMLElement {
    if (key === 'appIcon') return iconRow()
    if (key === 'archiveDir') return locationRow(current)
    if (key === 'about') return aboutRow()
    if (key === 'languageNotice') return languageNoticeRow()
    if (key === 'spellcheckLanguages') return spellcheckLanguagesRow(current)
    if (key === 'theme') return themeRow(current)
    if (key === 'zoomFactor') return zoomRow(current)

    const toggle = TOGGLES.find((spec) => spec.key === key)
    if (toggle !== undefined) return toggleRow(toggle, current)

    const size = SIZES.find((spec) => spec.key === key)
    if (size !== undefined) return sizeRow(size, current)

    throw new Error(`ui: 设置项 ${key} 在 ROW_ORDER 里，却没有对应的渲染`)
  }

  /**
   * 主题那一行（[ADR-0078]）。
   *
   * 用一个原生的**单选**下拉框，而不是复选框或"点一下换下一个"的循环按钮：这三个取值互斥
   * 且同等重要（"跟随系统"本身就是默认值，不是次要选项），而用户点进这一行想知道的两件事
   * 恰好是"现在是哪个"与"还能选哪些" —— 下拉框一眼同时给出两者，循环按钮一次只给一个。
   *
   * ⚠️ 这与被否掉的**原生多选**（`<select multiple>`，[ADR-0070]）不是一回事：那个的问题在
   * "要按住 Ctrl 才勾得上第二项"，单选没有这个问题。
   *
   * 提示文案必须写出**边界**：网页版自己的主题存在账号上（与界面语言同源），我们这一层没有
   * 可动的杠杆 —— 只写"改主题"会让点完没看到内嵌页面变化的用户以为功能坏了。
   */
  function themeRow(current: Settings): HTMLElement {
    const select = h('select', {
      title: '界面主题',
      dataRole: 'theme-select',
      onChange: (event) => {
        const value = (event.target as HTMLSelectElement).value as ThemeSource
        void patch({ theme: value })
      },
    })

    for (const option of THEME_OPTIONS) {
      select.append(
        h('option', {
          value: option.value,
          text: option.label,
          // 这一行每次都是整体重建的，因此属性就是它最终的样子（见 `dom.ts` 的 `selected`）。
          selected: option.value === current.theme,
        }),
      )
    }

    return h(
      'div',
      { class: 'setting' },
      select,
      h(
        'div',
        { class: 'meta' },
        h('div', { class: 'label', text: '主题' }),
        h('div', {
          class: 'hint',
          text: '改的是 WaaChat 自己的窗口（立即生效）。内嵌的网页版另有一处自己的主题设置，它在"跟随系统"时才会跟着这里变 —— 我们不去碰页面里的那个选择。',
        }),
      ),
    )
  }

  /**
   * 界面缩放那一行（[ADR-0079]）。
   *
   * 与主题同一形状（原生单选下拉框），选项与**应用菜单里的档位**是同一张表
   * （`shared/zoom.ts` 的 `ZOOM_OPTIONS`）—— 两处各写一张表的症状是"菜单走到 110% 时下拉框里
   * 没有这一项"，于是它显示成表里的第一项：一个安静的谎（界面说 50%、实际是 110%）。
   *
   * 提示里要把快捷键写出来：菜单栏默认隐藏（`autoHideMenuBar`），而"字太小"的人常常是先按
   * `Ctrl` + `+` 试一下，找不到才会来设置里翻。
   */
  function zoomRow(current: Settings): HTMLElement {
    const select = h('select', {
      title: '界面缩放',
      dataRole: 'zoom-select',
      onChange: (event) => {
        const value = Number((event.target as HTMLSelectElement).value)
        void patch({ zoomFactor: value })
      },
    })

    for (const option of ZOOM_OPTIONS) {
      select.append(
        h('option', {
          value: String(option.value),
          text: option.label,
          selected: option.value === current.zoomFactor,
        }),
      )
    }

    return h(
      'div',
      { class: 'setting' },
      select,
      h(
        'div',
        { class: 'meta' },
        h('div', { class: 'label', text: '界面缩放' }),
        h('div', {
          class: 'hint',
          text: '三扇窗口一起放大或缩小（立即生效，不用重启）。也可以直接用 Ctrl + +（Ctrl + =）、Ctrl + -、Ctrl + 0 —— 在任何一扇窗口里都生效，与这里选的是同一个值。',
        }),
      ),
    )
  }

  /**
   * 发起一次切换。
   *
   * 界面**先**进入转换态再调 IPC：此刻设置还没变，因此那个复选框会被重新渲染回**已提交**
   * 的值（它不会先跳过去再跳回来），只是被禁用；结果回来之后由 `settings` 与结果行接手。
   */
  async function switchCache(target: boolean): Promise<void> {
    cacheSwitch = { kind: 'running', target }
    render()

    let result: CacheSwitchResult | null

    try {
      result = await bridge().switchCiphertextCache(target)
    } catch (error) {
      // 主进程拒绝（例如切换闸门）不该让界面卡在转换态。这一条属于 bug 路径，
      // 因此把原文带上 —— 排查的人需要它。
      cacheSwitch = {
        kind: 'failed',
        target,
        failure: 'write-failed',
        detail: error instanceof Error ? error.message : String(error),
        rolledBack: true,
      }
      render()
      return
    }

    // null = 开关已经是目标状态，这次调用什么都没做。不是错误：什么都不留下。
    if (result === null) {
      cacheSwitch = { kind: 'idle' }
      render()
      return
    }

    settings = result.settings

    cacheSwitch = result.ok
      ? {
          kind: 'done',
          enabled: result.enabled,
          converted: result.converted,
          pendingCleanup: result.pendingCleanup,
        }
      : {
          kind: 'failed',
          target,
          failure: result.failure,
          detail: result.detail,
          rolledBack: result.rolledBack,
        }

    render()
  }

  /**
   * 设置行里的动作按钮（"选择图片…" / "恢复默认" / "更改…"）。
   *
   * **它们必须长得一模一样**，因此视觉属性只有一个来源：`shared/action-button.ts`
   * （断言在 `test/unit/action-button.test.ts` 与离线自检里）。这里只补上事件 ——
   * 外观与行为分开，是因为"看起来一样"与"点了做什么"本来就是两件事。
   */
  function actionButton(options: {
    readonly text: string
    readonly disabled?: boolean
    readonly onClick: () => void
  }): HTMLButtonElement {
    return h('button', {
      ...actionButtonAttrs(options.text, options.disabled),
      onClick: options.onClick,
    })
  }

  /**
   * 应用图标。
   *
   * 三件事必须说清楚，否则用户会把"平台限制"读成"功能坏了"：
   *   - 支持哪些格式（PNG / JPG / ICO）；
   *   - 会被处理成什么样（居中裁剪成正方形、缩放）；
   *   - 三个落点各自的生效时机（窗口与托盘立即，启动器要刷新桌面）。
   */
  function iconRow(): HTMLElement {
    const busy = icon.kind === 'busy'
    const custom = appIcon?.custom ?? false
    const preview = iconPreview ?? appIcon?.preview ?? null

    async function pick(): Promise<void> {
      icon = { kind: 'busy' }
      render()

      const picked = await bridge().pickAppIcon()

      // null = 用户取消了对话框。取消不是错误，状态清干净即可。
      if (picked === null) {
        icon = { kind: 'idle' }
        render()
        return
      }

      if (!picked.ok) {
        icon = { kind: 'failed', text: describeIconFailure(picked.failure, picked.detail) }
        render()
        return
      }

      const cropped = await cropToAppIcon(picked.bytes)
      if (!cropped.ok) {
        icon = { kind: 'failed', text: describeIconFailure(cropped.failure, picked.name) }
        render()
        return
      }

      // 先把裁剪结果亮出来（这一步就是"实时预览"），再去落盘。
      iconPreview = cropped.preview
      render()

      const result = await bridge().setAppIcon({ png: cropped.png })
      if (!result.ok) {
        // 主进程失败时什么都没改，因此预览退回当前**实际生效**的那张 —— 不能留着一张
        // 看上去已生效、实际没生效的图。
        iconPreview = null
        icon = { kind: 'failed', text: describeIconFailure(result.failure, result.detail) }
        render()
        return
      }

      appIcon = result.state
      iconPreview = null
      icon = { kind: 'ok', text: '已生效：窗口与托盘已经用上新图标。' }
      render()
    }

    async function reset(): Promise<void> {
      icon = { kind: 'busy' }
      render()

      const result = await bridge().resetAppIcon()
      if (!result.ok) {
        icon = { kind: 'failed', text: describeIconFailure(result.failure, result.detail) }
        render()
        return
      }

      appIcon = result.state
      iconPreview = null
      icon = { kind: 'ok', text: '已恢复默认图标。' }
      render()
    }

    return h(
      'div',
      { class: 'setting' },
      preview === null
        ? h('div', { class: 'icon-preview placeholder', text: '?' })
        : h('img', { class: 'icon-preview', src: preview, alt: '当前应用图标' }),
      h(
        'div',
        { class: 'meta' },
        h('div', { class: 'label', text: '应用图标' }),
        h('div', {
          class: 'hint',
          text: 'PNG / JPG / ICO 都可以。会自动居中裁剪成正方形，再缩放到 512×512。',
        }),
        h('div', {
          class: 'path',
          text: custom ? '当前：自定义图标' : '当前：默认图标',
        }),
        h('div', {
          class: 'hint',
          /**
           * 命名实例**不写**启动器条目（那份是全机唯一的，归默认实例管，见
           * `integration/appicon.ts`）。照抄默认实例那句话会得到一个承诺了却不会发生的
           * 结果 —— "我改了图标，启动器怎么没变"。
           */
          text:
            instanceInfo?.isDefault === false
              ? '窗口与托盘图标立即生效。启动器条目由默认实例维护：本实例不会去动它（那份条目全机只有一份，两个实例同时改会互相覆盖）。'
              : '窗口与托盘图标立即生效。启动器 / 任务栏图标由桌面环境缓存，要重新登录桌面（或注销再进来）之后才会更新。',
        }),
        iconStatusNode(),
      ),
      h(
        'div',
        { class: 'actions' },
        actionButton({
          text: busy ? '处理中…' : '选择图片…',
          disabled: busy,
          onClick: () => void pick(),
        }),
        actionButton({
          text: '恢复默认',
          // 没有自定义图标时禁用它：那个按钮此时什么也不会发生。
          disabled: busy || !custom,
          onClick: () => void reset(),
        }),
      ),
    )
  }

  /** 图标那一行的结果行。没有可说的就返回 `null`（而不是一个空节点）。 */
  function iconStatusNode(): HTMLElement | null {
    switch (icon.kind) {
      case 'idle':
        return null

      case 'busy':
        return h('div', { class: 'path', data: { state: 'running' }, text: '正在处理…' })

      case 'ok':
        return h('div', { class: 'path', data: { state: 'ok' }, text: icon.text })

      case 'failed':
        return h('div', { class: 'path', data: { state: 'error' }, text: icon.text })
    }
  }

  /**
   * 文件保存位置。
   *
   * 换位置是一次**真实的文件搬动**（确认框在主进程里弹，见 ipc/index.ts），因此这一行
   * 要承担进度与结果：搬了多少、成没成、失败后数据在哪。这些都不能靠用户去看日志。
   */
  function locationRow(current: Settings): HTMLElement {
    const running = location.kind === 'running'

    async function pick(): Promise<void> {
      // 先清掉上一次的结果：否则上一次的"已完成"会和这一次的进度混在一起。
      location = { kind: 'idle' }
      render()

      const result = await bridge().pickArchiveDir()

      // null = 用户在任一步取消（选目录、或确认框里点了取消）。存储位置一点没变。
      if (result === null) {
        location = { kind: 'idle' }
        render()
        return
      }

      if (!result.ok) {
        location = {
          kind: 'failed',
          failure: result.failure,
          detail: result.detail,
          rolledBack: result.rolledBack,
        }
        render()
        return
      }

      settings = result.settings
      location = { kind: 'done', target: result.target, files: result.migrated.files }
      render()
    }

    /**
     * 结构与应用图标那一行**同构**：文字列在前（`.meta` 撑开剩余宽度），操作列在最后
     * （`.actions`，因此按钮贴右边缘）。按钮换个位置就会让两行的对齐规则各说各话 ——
     * `test/unit/settings-view.test.ts` 把这条顺序钉住。
     */
    return h(
      'div',
      { class: 'setting' },
      h(
        'div',
        { class: 'meta' },
        h('div', { class: 'label', text: '文件保存位置' }),
        h('div', {
          class: 'hint',
          text: '更改时会先确认，然后把已有的归档迁移到新位置。归档是解密后的明文，不建议放在云同步盘里。',
        }),
        h('div', { class: 'path', text: current.archiveDir }),
        locationStateNode(),
      ),
      h(
        'div',
        { class: 'actions' },
        actionButton({
          text: running ? '迁移中…' : '更改…',
          disabled: running,
          onClick: () => void pick(),
        }),
      ),
    )
  }

  /** 迁移的过程与结果。没有可说的就返回 `null`（而不是一个空节点）。 */
  function locationStateNode(): HTMLElement | null {
    switch (location.kind) {
      case 'idle':
        return null

      case 'running':
        return h('div', {
          class: 'path',
          data: { state: 'running' },
          text: describeMigrationProgress(location.progress),
        })

      case 'done':
        return h('div', {
          class: 'path',
          data: { state: 'ok' },
          text: `已迁移 ${location.files} 个文件到 ${location.target}`,
        })

      case 'failed': {
        // 回滚成功的失败与回滚失败的失败**不是一回事**：前者存储位置没变，用户什么都
        // 不需要做；后者两侧都可能留有数据，必须提示人工核对。所以这一句要分开写。
        const tail = location.rolledBack
          ? '存储位置未变，已有归档仍在原目录。'
          : '⚠️ 部分文件可能仍留在新位置，请核对两处后再继续使用。'

        return h('div', {
          class: 'path',
          data: { state: 'error' },
          text: `迁移失败：${describeMigrationFailure(location.failure, location.detail)}${tail}`,
        })
      }
    }
  }

  /**
   * 「有改动还没生效」那一条（[ADR-0064]）。
   *
   * 只在真有等待重启的项时才画：常驻一条提示是噪音，而且会让"刚刚那次改动"失去信号。
   * 位置在**整个列表的最前面**（见 {@link render}）—— 它是一句要用户做事的提示，
   * 埋在最后等于没说。
   *
   * 触发点是 `RESTART_REQUIRED_SETTINGS` —— 今天那条名单里有 `smoothScrolling`（[ADR-0081]），
   * 因此这条路径是活的。自检第 19 节断言界面里确实有这个触发点，而不是只剩一条没人用的通道。
   */
  function pendingRestartRow(): HTMLElement | null {
    if (restartState.restart.length === 0) return null

    return h(
      'section',
      { class: 'group' },
      h('h2', { class: 'group-title', text: '待生效' }),
      h(
        'div',
        { class: 'setting' },
        h(
          'div',
          { class: 'meta' },
          h(
            'div',
            { class: 'label' },
            '改动还没生效',
            h('span', { class: 'badge', text: '重启后生效' }),
          ),
          h('div', {
            class: 'hint',
            text: '改动已经保存，但要让它真的运行起来，需要重启一次。',
          }),
        ),
        h(
          'div',
          { class: 'actions' },
          actionButton({
            text: '立即重启',
            onClick: () => {
              /**
               * ⚠️ **不 await、也不在之后做任何事**：这一步会让进程退出，回调落在空处
               * （[ADR-0064]）。失败也没有可展示的余地 —— 那意味着连退出都没发生，
               * 用户再点一次即可。
               */
              void bridge().restart()
            },
          }),
        ),
      ),
    )
  }

  /**
   * 「界面语言」那一行 —— 它现在是一句**说明**，不是一个设置项（[ADR-0066]）。
   *
   * 为什么撤掉可改的那一半：网页版的语言由**账号**决定，具体地说是随账号同步下来的**手机语言**
   * （`WALangPhonePref`）。三种杠杆都试过了 —— 会话的 `Accept-Language`（[ADR-0060]）、启动期的
   * `--lang`（[ADR-0063]）、网页版自己那条偏好 cookie（[ADR-0065]）—— 实测的结论是：登录之后
   * 页面会在 2–3 秒内把 cookie 改回账号语言并按它渲染，用户只看到"闪一下目标语言、然后变回去"
   * （`docs/research/lang-preference.md` §4.5）。因此这一项的入口只在**手机端**，这里能做的只有
   * 把这件事说清楚。
   *
   * ⚠️ 文案里必须出现"手机版 WhatsApp"这几个字：用户找到这一行就是想换语言，而"语言跟随账号"
   * 这种说法他不知道该去哪里改。自检第 19 节断言这句说明在位（连"改哪里"一起）。
   *
   * 结构与其它行**不同构**：没有 `.actions` —— 这里没有任何可动的东西，放一个灰掉的下拉框只会
   * 让人去点它。
   */
  function languageNoticeRow(): HTMLElement {
    return h(
      'div',
      { class: 'setting' },
      h(
        'div',
        { class: 'meta' },
        h('div', { class: 'label', text: '界面语言' }),
        h('div', {
          class: 'hint',
          text: '内嵌页面的语言由你的手机版 WhatsApp 决定 —— 网页版没有自己的语言设置，我们在这里也改不动它。请在手机的 WhatsApp 里更改（语言跟随账号），改完这边会自动跟着变。',
        }),
      ),
    )
  }

  /**
   * 一门词典的下载进度（[ADR-0071]）。
   *
   * 两块：一条**进度条**（四态见 `DictionaryStatus`）+ 一句**只在需要解释时才出现的**文字。
   * 分工是这样定的：
   *
   *   - `ready` **只有**一条走满的蓝条 —— "走满"就是这件事的全部结论，再写一句"已就绪"
   *     只是噪音（而它不会再变回别的样子，见 `nextDictionaryStatus()`）；
   *   - `downloading` / `failed` 各带一句话：这两种情况**都要用户等一下或做点什么**。条本身
   *     分得出"正在下"（一段蓝在走）与"下好了"（走满的蓝），但那句"下载中…"是给**不盯着这一格**
   *     的人读的（关掉动效时两态只差浓淡，那句话就更是唯一的抓手），`failed` 那句则要把
   *     "这门语言不会被标注"说出来；
   *   - `unknown` 是一条**空槽**：它不是失败，是"还没听到关于它的任何消息"。
   *
   * 那个文字节点**总是**画出来（`ready` / `unknown` 时是空串）：它占着一份固定的宽度，
   * 于是状态变化时后面那颗 `⋯` 不会左右跳。
   */
  function dictionaryProgressNode(status: DictionaryStatus): HTMLElement[] {
    const text = status === 'downloading' ? '下载中…' : status === 'failed' ? '下载失败' : ''

    return [
      h('span', {
        class: 'language-progress',
        data: { state: status },
        title: DICTIONARY_STATUS_TITLES[status],
      }),
      h('span', {
        class: 'language-status',
        data: { state: status },
        text,
      }),
    ]
  }

  /**
   * 拼写检查的词典那一行：已选语言列成一张**清单**（一门一行，右侧一颗 `⋯`），清单头上是
   * 「添加语言」（[ADR-0070]，取代 [ADR-0069] 的决定 1 那条"只留一个触发器"）。
   *
   * ⚠️ 清单显示的是**已保存**的那一组，不是对话框里的草稿 —— 本文件开头第 1 条：界面显示的
   * 就是实际生效的（草稿不是）。
   *
   * 每一行带三样东西，后两样是 [ADR-0087] 加的：
   *
   *   1. 一条**下载进度**（[ADR-0071]）：内核只发事件、不给百分比，所以它表达的是状态而不是
   *      "下了百分之几"（映射见 {@link dictionaryProgressNode}）。这一格存在的理由是"过了好久
   *      才显示下载失败"那件事的另一半 —— 等待期间要看得见它在动；
   *   2. 一个**开关**：这一门要不要参与检查。取消勾选之后它**留在清单里**（用户不必回到对话框里
   *      重新搜它），只是不交给内核、也不去下载它的词典；
   *   3. 一个**拖动把手**（其实整行都可拖）：清单的次序由用户排、并原样存下。
   *
   * ⚠️ 次序**不是**优先级：内核把列出的语言当一**组**查（[ADR-0075] 的并集语义，实测），排第一
   * 与排最后一门一样会被查。因此这一行上面**不许**出现"首选语言"之类的话 —— 那会让人以为改次序
   * 能改变判定结果（[ADR-0070] 否决「移到顶部」时防的正是这件事；[ADR-0087] 接下"顺序可以自己排"
   * 时划的边界也在这里）。
   *
   * 拼写检查关着时整块禁用（连拖动与每一门的开关一起停），提示语也换成"这一行跟着停用"：
   * 一份"给谁查"的清单离开了那个开关就读不懂。要停用整个功能，请用上面那个开关（它同时还意味着
   * 不去下载词典）。
   */
  function spellcheckLanguagesRow(current: Settings): HTMLElement {
    const entries = parseDictionaryList(current.spellcheckLanguages)
    const labelOf = new Map(SPELLCHECK_LANGUAGES.map((entry) => [entry.code, entry.label]))
    const off = !current.spellcheck

    /**
     * 「至少要留一门」在**这一侧**的两个落点：只剩一门时不给「移除」，只剩一门**参与检查**时
     * 不给停用它（另一侧在对话框里：草稿为空时禁用「确定」）。两处都不重复：那一侧防的是"草稿被
     * 勾空"，这一侧动的是**已存下的**那一组。
     *
     * 两条同源：内核拿到一个空清单就等于"什么都不查"，而那与"功能坏了"在用户看来没有区别
     * （[ADR-0070]；停用这一侧见 [ADR-0087]，兜底仍是 `normalizeSpellcheckLanguages()`）。
     */
    const removable = entries.length > 1
    const enabledCount = entries.filter((entry) => entry.enabled).length

    const items = entries.map((entry, index) => {
      const code = entry.code
      const menuButton = h('button', {
        class: 'language-menu-button',
        type: 'button',
        title: '对这一门词典的操作',
        text: '⋯',
        dataRole: 'language-menu-button',
        disabled: off,
        // 菜单挂在**这一行**里（行是它的定位参照），因此把触发它的那颗按钮当锚点传进去。
        onClick: () =>
          openLanguageMenu(menuButton, code, {
            removable,
            atTop: index === 0,
            atBottom: index === entries.length - 1,
          }),
      })

      /**
       * 整块停用时**不画**进度：一份下到哪了的报告离开了那个开关就没有对象 ——
       * 而一条停在蓝/红上的条子会让人以为"拼写检查关着，但词典还在用"。
       *
       * 这一门**自己**被停用时同理（[ADR-0087]）：它此刻没有在被下载，留一条走满的蓝条等于说反了
       * 话（蓝条的意思是"这一门已经装好、正在用它查"）。
       */
      const status = dictionaryStatuses[dictionaryKey(code)] ?? 'unknown'
      const stoppable = !(entry.enabled && enabledCount === 1)

      return h(
        'div',
        {
          class: 'language-item',
          dataRole: 'language-item',
          data: { code, enabled: entry.enabled ? 'true' : 'false' },
          // 整块停用时也不给拖：这一行既然"跟着停用"，能拖就是在说它还是一件活的东西。
          draggable: !off,
        },
        /**
         * 拖动把手：一个**位置**（这一行的左边缘），不是一颗按钮 —— 能拖的是**整行**（行里有两三个
         * 可点的子控件，只让把手能拖会把"抓哪儿"变成一道要试的题），而把手是那条规矩看得见的说明。
         */
        h('span', {
          class: 'language-handle',
          title: off ? '拼写检查关着' : '拖动这一行可以改变清单的顺序',
          text: '⠿',
        }),
        h('span', { class: 'language-name', text: labelOf.get(code) ?? code }),
        /**
         * 语言码与名字并排，是因为**存下来的**就是它（`settings.json` 里是 `en-US,de`）——
         * 与内核、日志、上游文档对得上的是这一串，而不是我们的中文名。
         */
        h('span', { class: 'language-code', text: code }),
        ...(off || !entry.enabled ? [] : dictionaryProgressNode(status)),
        /**
         * 这一门的开关。贴在 `⋯` 左边：它说的是"这一门**现在**参不参与检查"（状态），而 `⋯` 里是
         * "对这一门做什么"（动作）—— 与其它行"控件在左、动作在右"是同一个方向感。
         *
         * 为什么是一个开关而不是"从清单里删掉"：停用是**可逆**的（"这一阵子先别用它查"），删掉之后
         * 要再用它就得回到对话框里重新搜一遍。真的不要了，用 `⋯` 里的「移除」。
         */
        h('input', {
          type: 'checkbox',
          class: 'language-toggle',
          checked: entry.enabled,
          disabled: off || !stoppable,
          title: !stoppable
            ? '至少要留一门参与检查 —— 要整块停用，请用上面那个开关'
            : entry.enabled
              ? '这一门正在参与拼写检查：取消勾选可以暂时不用它（它会留在清单里）'
              : '这一门没在参与：勾上它会立刻开始查（词典可能要先下载）',
          onChange: (event) => {
            void setDictionaryEnabled(code, (event.target as HTMLInputElement).checked)
          },
        }),
        menuButton,
      )
    })

    return h(
      'div',
      { class: 'setting' },
      /**
       * **两段式**：表头（说明 + 「添加语言」）在上，清单在下。
       *
       * 说明在前、按钮**贴右**：说明与那颗按钮说的是同一件事（这几门是怎么来的、怎么改），因此
       * 它们同一行 —— 说明占满这一行（`.meta` 是 `flex: 1`），按钮被推到右端，与参考图里那颗
       * 按钮同一个位置。
       *
       * 与其它行的"控件 + 说明"两栏不同：这里的右栏会被清单占掉，而说明有两三行字 —— 设置窗口
       * 只有 960px 宽（`LOCAL_WINDOW_SIZE`），挤在右栏里就是一根细条，视线还得在左右两栏之间
       * 来回跳。
       */
      h(
        'div',
        { class: 'language-field' },
        h(
          'div',
          { class: 'language-head' },
          h(
            'div',
            { class: 'meta' },
            h('div', { class: 'label', text: '拼写检查的词典' }),
            h('div', {
              class: 'hint',
              text: off
                ? '拼写检查关着，这一行跟着停用 —— 开着它才会去下载词典。'
                : '勾上的每一门都会被查（内核不会自己判断你在打哪种语言）；取消勾选只是把它留在清单里，不再参与标注。清单的顺序由你自己排，它不影响判定 —— 内核把勾上的语言当一组一起查。',
            }),
          ),
          actionButton({
            text: '添加语言',
            disabled: off,
            onClick: () => openLanguageDialog(),
          }),
        ),
        /**
         * 四个拖动事件挂在**容器**上而不是每一行上：它们都冒泡，而且拖动逻辑本来只有一套 ——
         * 一行挂一遍的话，每次重画都得重新挂，漏一处就是"这一行拖不动"。
         *
         * ⚠️ 少任何一个都不会报错：没有 `draggable` 是拖不起来，`dragover` 里不 `preventDefault()`
         * 是松手什么都不发生，没有 `drop` 是白拖一场。三者缺一都只表现为"这个功能好像有点怪"。
         */
        h(
          'div',
          {
            class: 'language-items',
            dataRole: 'language-items',
            onDragStart: onLanguageDragStart,
            onDragOver: onLanguageDragOver,
            onDrop: onLanguageDrop,
            onDragEnd: finishLanguageDrag,
          },
          ...items,
        ),
      ),
    )
  }

  /**
   * 打开某一行的 `⋯` 菜单（[ADR-0070]）。
   *
   * 今天有三项：「上移」「下移」「移除」。前两项是[拖动]{@link onLanguageDrop}那条路的**键盘**
   * 版本（[ADR-0087]）—— 一件只能用鼠标做的事，对不用鼠标的人等于不存在；而参考图里那第三项
   * 「以这种语言显示」仍然不搬（那是 [ADR-0066] 撤掉的界面语言）。「移到顶部」也不搬：把它排到
   * 第一**不改变任何判定**（内核按**一组**查，[ADR-0075]），而一个"按了什么都不影响"的项正是
   * [ADR-0070] 当年要防的那件事；「上移 / 下移」不同，它们的产出是**看得到的次序**。
   *
   * 做成菜单而不是几颗裸按钮，是因为"这一行能对它自己做什么"是一个**位置**，不是一颗特定的
   * 按钮（理由写在 ADR 里）。
   *
   * 三条收尾的路：点菜单之外、`Esc`、以及**任何一次重画** —— 菜单挂在行元素里面，而 `render()`
   * 换掉的是整棵子树，因此它也必须在 `render()` 里被收掉（否则留下一个还挂在 `document` 上的
   * 监听器）。菜单也没有草稿，收起即无副作用 —— 这正是它不必做成 `<dialog>` 的原因。
   */
  function openLanguageMenu(
    anchor: HTMLElement,
    code: string,
    options: { readonly removable: boolean; readonly atTop: boolean; readonly atBottom: boolean },
  ): void {
    closeLanguageMenu()

    /**
     * 到头了的那一项**禁用**而不是隐藏：藏起来会让"为什么没有这一项"无从解释，而灰掉的那一项
     * 本身就是那句解释（悬停有 `title`）。
     */
    function nudgeItem(
      text: string,
      delta: -1 | 1,
      atEdge: boolean,
      edgeTitle: string,
    ): HTMLElement {
      return h('button', {
        class: 'language-menu-item',
        type: 'button',
        title: atEdge ? edgeTitle : `${text}一位`,
        text,
        disabled: atEdge,
        onClick: () => nudgeDictionary(code, delta),
      })
    }

    const menu = h(
      'div',
      { class: 'language-menu', dataRole: 'language-menu' },
      nudgeItem('上移', -1, options.atTop, '已经在最上面了'),
      nudgeItem('下移', 1, options.atBottom, '已经在最下面了'),
      h('button', {
        class: 'language-menu-item',
        type: 'button',
        title: options.removable ? '不再查这一门' : '至少要留一门',
        text: '移除',
        disabled: !options.removable,
        onClick: () => removeDictionary(code),
      }),
    )

    anchor.after(menu)
    languageMenu = menu
    document.addEventListener('click', dismissLanguageMenu)
    document.addEventListener('keydown', onLanguageMenuKeydown)
  }

  /**
   * 点菜单**之外**即关。
   *
   * 两处豁免都在同一句里：点菜单自己（由那一项自己收尾，别在这里抢）、点任意一颗 `⋯`（那一颗
   * 会换成自己的菜单 —— 在这里先关掉会让它闪一下）。
   */
  function dismissLanguageMenu(event: Event): void {
    const target = event.target

    if (
      target instanceof Element &&
      target.closest('[data-role="language-menu"], [data-role="language-menu-button"]') !== null
    ) {
      return
    }

    closeLanguageMenu()
  }

  function onLanguageMenuKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') closeLanguageMenu()
  }

  /**
   * 收掉菜单（幂等）。`render()` 与 `dispose()` 都要调 —— 那两处是它全部的清理时机。
   */
  function closeLanguageMenu(): void {
    if (languageMenu === null) return

    languageMenu.remove()
    languageMenu = null
    document.removeEventListener('click', dismissLanguageMenu)
    document.removeEventListener('keydown', onLanguageMenuKeydown)
  }

  /**
   * 清单此刻**已保存**的那一份（不是这一帧画出来的那一份）。
   *
   * 拖放 / 停用 / 上移下移 / 移除这四个动作都从它出发：作用对象是设置里的值，而在这期间 `settings`
   * 可能已经被主进程推来的新值换过（[ADR-0079] 那条 `onSettingsChanged`）。按已保存的那一份算，
   * 才不会把两次改动里较早的那一份写回去。
   */
  function currentEntries(): SpellcheckEntry[] {
    return parseDictionaryList(settings?.spellcheckLanguages ?? '')
  }

  /**
   * 写回一份新清单。
   *
   * 空清单当作"没发生"：它会被 `normalizeSpellcheckLanguages()` 收敛回默认值，看起来像"它自己
   * 变回去了"。界面上的两个闸门（只剩一门时禁用「移除」、只剩一门参与检查时禁用开关）本来就
   * 到不了这里，因此这一条是兜底而不是规则。
   */
  function commitLanguages(entries: readonly SpellcheckEntry[]): void {
    if (entries.length === 0) return

    void patch({ spellcheckLanguages: formatDictionaryList(entries) })
  }

  /**
   * `⋯` 里的「移除」：把这一门从**已保存**的那一组里拿掉（[ADR-0070]）。
   *
   * 它**不走草稿**：作用对象是已保存的值，而对话框里那份草稿要保住的是"改到一半改主意"。
   * 顺序与**别的门的开关**都不动（原样过滤），因此删掉一门不会顺手重排或重启谁。
   */
  function removeDictionary(code: string): void {
    closeLanguageMenu()
    commitLanguages(currentEntries().filter((entry) => entry.code !== code))
  }

  /**
   * 停用 / 启用一门（[ADR-0087]）。
   *
   * ⚠️ 不从清单里删掉：停用是**可逆**的（"这一阵子先别用它查"），而删掉之后要再用它，得回到对话框
   * 里在 24 门里重新找到它。「移除」是另一件事，在 `⋯` 里。
   */
  function setDictionaryEnabled(code: string, enabled: boolean): void {
    commitLanguages(
      currentEntries().map((entry) => (entry.code === code ? { code, enabled } : entry)),
    )
  }

  /**
   * 拖动 / 放下事件落在哪一行上（`null` = 不在任何一行上：落在表头、行与行之间的缝、或窗口空白处）。
   *
   * ⚠️ 认的是**行元素**而不是"当前悬停的那个子节点"：指针多半落在名字或那条进度条上，而落点是按
   * 整行的几何算的（见 {@link onLanguageDragOver}）。
   */
  function languageRowOf(event: Event): HTMLElement | null {
    const target = event.target
    if (!(target instanceof Element)) return null

    return target.closest<HTMLElement>('[data-role="language-item"]')
  }

  /**
   * 开始拖一行。
   *
   * 整行都可拖（`draggable` 在 `.language-item` 上），因此这里第一件事是认"拖的是哪一行"。行上带着
   * 自己的语言码（`data-code`），拖动期间只认它 —— 重画会把元素换掉，认码才不会认错（见
   * {@link draggedLanguage}）。
   */
  function onLanguageDragStart(event: Event): void {
    if (!(event instanceof DragEvent)) return

    const row = languageRowOf(event)
    const code = row?.dataset['code']
    if (row === null || code === undefined) return

    // 菜单挂在行里，而这一行正要被挪走：拖着它的时候它没有意义。
    closeLanguageMenu()
    // 上一次拖动的残留（拖到一半被重画打断时 `dragend` 不会来）在这里收干净。
    finishLanguageDrag()

    draggedLanguage = code
    draggedLanguageRow = row
    row.dataset['dragging'] = 'true'

    /**
     * 拖拽数据本身我们**不用**（清单只在自己内部排，外部拖进来的东西一概不接），但 Chromium
     * 要求至少有一项，否则这次拖动根本不会开始 —— 症状是"按住拖不动"，而且没有任何报错。
     */
    if (event.dataTransfer !== null) {
      event.dataTransfer.setData('text/plain', code)
      event.dataTransfer.effectAllowed = 'move'
    }
  }

  /**
   * 拖动经过某一行：算出"插到它前面还是后面"，并把那条线画出来。
   *
   * `dragover` 是唯一能把一行变成**合法落点**的事件 —— 不 `preventDefault()` 的话，松手时浏览器
   * 什么都不做（而拖了一路却什么都没发生，看起来正像我们的 bug）。它每秒会来很多次，因此落点的
   * DOM 只在**真的变了**的时候写（见 {@link setLanguageDropTarget}）。
   */
  function onLanguageDragOver(event: Event): void {
    if (draggedLanguage === null || !(event instanceof DragEvent)) return

    const row = languageRowOf(event)
    const code = row?.dataset['code']
    if (row === null || code === undefined) return

    /**
     * 落在自己身上：不接收、也不画线 —— "把 A 插到 A 前面"是空操作，而画一条线会让人以为松手之后
     * 它会动一下。
     */
    if (code === draggedLanguage) {
      clearLanguageDropTarget()
      return
    }

    event.preventDefault()
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'

    /**
     * 指针在**上半行**就是插入到这一行**之前**。判据只看指针此刻的位置（不看"上一次落在谁身上"），
     * 因此往回拖与往前拖走的是同一条判定 —— 两个方向各写一套的话，它们总有一边差一格。
     */
    const rect = row.getBoundingClientRect()
    setLanguageDropTarget(row, event.clientY > rect.top + rect.height / 2)
  }

  /**
   * 落点那条线用 `data-drop` 表达（`before` / `after`，样式画在那一行的**上 / 下边缘**）。
   *
   * 只在换了行或换了半边时才动 DOM：`dragover` 每次移动来一发，无条件重写属性会让整张清单跟着重画
   * （而"落点在哪一行"正是这一刻唯一要看的东西）。
   */
  function setLanguageDropTarget(row: HTMLElement, after: boolean): void {
    if (dropLanguageRow === row && dropLanguageAfter === after) return

    clearLanguageDropTarget()
    dropLanguageRow = row
    dropLanguageAfter = after
    row.dataset['drop'] = after ? 'after' : 'before'
  }

  function clearLanguageDropTarget(): void {
    if (dropLanguageRow !== null) delete dropLanguageRow.dataset['drop']

    dropLanguageRow = null
    dropLanguageAfter = false
  }

  /**
   * 收掉这一次拖动（幂等）。三个时机都要调：松手放下、拖动被取消（`dragend`）、以及**每一次
   * `render()`** —— 后者换掉的是整棵子树，那两处状态必须跟着清，否则下一次 `dragover` 会拿一个
   * 已经不在屏幕上的行去算落点（与 `⋯` 菜单同一条纪律，见 {@link languageMenu}）。
   */
  function finishLanguageDrag(): void {
    if (draggedLanguageRow !== null) delete draggedLanguageRow.dataset['dragging']

    draggedLanguageRow = null
    draggedLanguage = null
    clearLanguageDropTarget()
  }

  /**
   * 放下一行（[ADR-0087]）：把被拖的那一门挪到落点那一行的前面 / 后面，然后写回设置。
   *
   * ⚠️ 落点必须在**清掉之前**读出来 —— {@link finishLanguageDrag} 会把那两处状态清空，而清空之后
   * 这一次拖动就没留下任何东西了（紧接着还会来一次 `dragend`，它是幂等的）。
   */
  function onLanguageDrop(event: Event): void {
    const code = draggedLanguage
    const target = dropLanguageRow?.dataset['code']
    const after = dropLanguageAfter

    finishLanguageDrag()

    if (code === null || target === undefined || code === target) return

    // 落在这一行上就是一个合法动作（否则浏览器根本不会发 `drop`）；它的默认动作是把拖拽数据当
    // 文本交给页面，而这里没有页面可交。
    event.preventDefault()

    commitLanguages(moveDictionary(currentEntries(), code, target, after))
  }

  /**
   * `⋯` 里的「上移 / 下移」：拖动那条路的键盘版本（[ADR-0087]）。
   *
   * 到边界的那一项在菜单里是禁用的，因此这里不必再判一次 —— 与 {@link commitLanguages} 同一条
   * "闸门挡在前面，后面只做兜底"的分工。
   */
  function nudgeDictionary(code: string, delta: -1 | 1): void {
    closeLanguageMenu()
    commitLanguages(stepDictionary(currentEntries(), code, delta))
  }

  /**
   * 打开「选择拼写检查的词典」对话框（[ADR-0069]）。
   *
   * 形态照 Edge 的「添加语言」：标题 + 搜索框 + 一张可滚动的清单 + 「取消 / 确定」。三处**刻意
   * 的不同**（理由都在那条 ADR 里）：清单是**复选框**（我们本来就允许多门一起查）；勾选改的是
   * **草稿**、按「确定」才写回；点遮罩**不**关 —— 那个手势会丢掉草稿，而退出的路子已经有取消 /
   * × / Esc 三条。
   *
   * ⚠️ 对话框管的是"清单里**有哪几门**"，不是"哪几门在查"（那是清单行上那个开关的事，[ADR-0087]）：
   * 这里勾上的每一门写回之后都**保持它原来的开关状态与位置**，头一次出现的那几门排在最后。
   *
   * ⚠️ 对话框挂在 `document.body` 上，不是 `root` 里：`patch()` → `render()` 会把 `root` 的
   * 子树整个换掉，而它要活过任意次重画。
   */
  function openLanguageDialog(): void {
    if (languageDialog !== null || settings === null) return

    /**
     * 打开那一刻的清单。整个对话框（含写回）都以它为基准 —— 拖动 / 停用 / 上移下移不会与它同时
     * 发生（那些控件被这层模态挡住），因此不需要每画一次再读一遍。
     */
    const current = parseDictionaryList(settings.spellcheckLanguages)
    const draft = new Set(current.map((entry) => entry.code))

    const list = h('div', { class: 'language-list', dataRole: 'language-list' })
    const search = h('input', {
      class: 'language-search',
      type: 'search',
      placeholder: '搜索语言',
      onInput: () => drawOptions(),
    })

    /**
     * 只重画**清单**：搜索框自己不能被重建，否则每敲一个字就丢一次焦点。
     *
     * 「至少要留一门」在这里由「确定」的禁用态拦住，而**不是**禁用最后一门复选框：后者要在每次
     * 勾选之后重画整张清单（否则那一门的禁用态不会跟着变），而重画会把用户刚点的那一项换成新节点、
     * 焦点也跟着丢。落到设置里的值另有一道兜底 —— `normalizeSpellcheckLanguages()` 把空列表
     * 收敛成默认。
     */
    function drawOptions(): void {
      const query = search.value.trim().toLowerCase()
      const matched = SPELLCHECK_LANGUAGES.filter(
        (entry) =>
          query === '' ||
          entry.label.toLowerCase().includes(query) ||
          entry.code.toLowerCase().includes(query),
      )

      clear(list)

      if (matched.length === 0) {
        list.append(h('div', { class: 'language-empty', text: '没有匹配的语言' }))
        return
      }

      for (const entry of matched) {
        list.append(
          h(
            'label',
            { class: 'language-option' },
            h('input', {
              type: 'checkbox',
              checked: draft.has(entry.code),
              onChange: (event) => {
                if ((event.target as HTMLInputElement).checked) draft.add(entry.code)
                else draft.delete(entry.code)

                confirm.disabled = draft.size === 0
              },
            }),
            h('span', { class: 'language-name', text: entry.label }),
            /**
             * 语言码与名字并排，是因为**存下来的**就是它（`settings.json` 里是 `en-US,de`）——
             * 与内核、日志、上游文档对得上的是这一串，而不是我们的中文名。
             */
            h('span', { class: 'language-code', text: entry.code }),
          ),
        )
      }
    }

    const confirm = h('button', {
      ...actionButtonAttrs('确定'),
      onClick: () => {
        /**
         * 写回：**已经在清单里的那几门原样留着** —— 次序与各自的开关状态都不动（[ADR-0087]）；
         * 新勾上的排在**最后**，一律参与检查。
         *
         * ⚠️ 这一条取代了 [ADR-0070] 的"写回时按 `SPELLCHECK_LANGUAGES` 那张表排"：清单的次序
         * 现在是**用户**的（拖动排的），再按表排一次就会把他刚排好的次序抹掉 —— 而他是来"加一门
         * 语言"的，不会想到顺手弄丢别的。
         */
        const known = new Set(current.map((entry) => entry.code))
        const kept = current.filter((entry) => draft.has(entry.code))
        const added = SPELLCHECK_LANGUAGES.filter(
          (entry) => draft.has(entry.code) && !known.has(entry.code),
        ).map((entry) => ({ code: entry.code, enabled: true }))

        dialog.close()

        /**
         * 结果里必须有**一门参与检查**的：草稿可以把唯一启用的那一门取消掉（只留下几门停用的），
         * 而那与"什么都不查"是同一件事 —— 那条规则只在一个地方实现（[ADR-0070]）。
         */
        void patch({
          spellcheckLanguages: formatDictionaryList(ensureEnabledDictionary([...kept, ...added])),
        })
      },
    })

    const dialog = h(
      'dialog',
      { class: 'language-dialog' },
      h(
        'div',
        { class: 'language-dialog-body' },
        h(
          'div',
          { class: 'language-dialog-head' },
          h('h2', { class: 'language-dialog-title', text: '选择拼写检查的词典' }),
          h('button', {
            class: 'language-close',
            type: 'button',
            title: '关闭',
            text: '✕',
            onClick: () => dialog.close(),
          }),
        ),
        search,
        list,
        h(
          'div',
          { class: 'language-dialog-foot' },
          h('button', { ...actionButtonAttrs('取消'), onClick: () => dialog.close() }),
          confirm,
        ),
      ),
    )

    languageDialog = dialog

    /**
     * `close` 是**唯一**的清理时机：取消、×、确定最后都走到它，Esc 由 `<dialog>` 自己处理
     * （它会先发 `cancel`、再 `close`）—— 因此这里不需要再听一次键盘。
     */
    dialog.addEventListener('close', () => {
      dialog.remove()
      languageDialog = null
    })

    drawOptions()
    confirm.disabled = draft.size === 0
    document.body.append(dialog)
    dialog.showModal()
    // 打开就把焦点放进搜索框：这张清单存在的意义就是"找到某一门语言"（顺带能直接打码，如 `ko`）。
    search.focus()
  }

  function toggleRow(spec: ToggleSpec, current: Settings): HTMLElement {
    const needsRestart = RESTART_REQUIRED_SETTINGS.includes(spec.key)
    // 转换期间禁用**这一个**开关：再拨一次只会撞上主进程的闸门。别的开关不受影响。
    const switching = spec.key === 'enableCiphertextCache' && cacheSwitch.kind === 'running'
    const implemented = spec.enforced ?? true
    /**
     * 归属另一个实例的项在这里**禁用**，而不是照常显示：开关拨下去主进程会跳过它，
     * 而"能拨、但没有效果"正是本文件开头第 2 条明令禁止的样子。
     *
     * 拿不到实例信息时**不禁用**（`instanceInfo === null`）—— 那是一次 IPC 失败，
     * 按"最不打扰用户"的那一边退让：他至少能操作，而这一项在默认实例下本来就是对的。
     */
    const otherInstance = spec.defaultInstanceOnly === true && instanceInfo?.isDefault === false

    const checkbox = h('input', {
      type: 'checkbox',
      checked: current[spec.key],
      disabled: switching || !implemented || otherInstance,
      // 与容量项同一个说法：悬停时就能看到"为什么它不能点"。
      ...(implemented ? {} : { title: '尚未生效' }),
      ...(otherInstance ? { title: '只有默认实例能设置这一项' } : {}),
      onChange: (event) => {
        const checked = (event.target as HTMLInputElement).checked

        /**
         * 密文缓存的开关**不走** `settings:set`：它必须伴随一次真实的文件转换与协议层的
         * 挂/摘（[ADR-0027]）。主进程也会拒绝绕道改它 —— 两边都拦，是因为"设置说关闭、
         * 磁盘上却还留着缓存"这种不一致一旦出现，用户是看不出来的。
         */
        if (spec.key === 'enableCiphertextCache') {
          void switchCache(checked)
          return
        }

        void patch({ [spec.key]: checked } as Partial<Settings>)
      },
    })

    return h(
      'label',
      { class: 'setting' },
      checkbox,
      h(
        'div',
        {},
        h(
          'div',
          { class: 'label' },
          spec.label,
          ...(needsRestart ? [h('span', { class: 'badge', text: '重启后生效' })] : []),
        ),
        ...(spec.hint === '' ? [] : [h('div', { class: 'hint', text: spec.hint })]),
        ...(otherInstance
          ? [
              h('div', {
                class: 'hint',
                text: `这一项归默认实例管：它对应的系统条目全机只有一份，两个实例同时改会互相覆盖。要开机启动这个实例，请单独做一个启动器条目（命令里带 --profile 参数）。`,
              }),
            ]
          : []),
        ...(spec.key === 'enableCiphertextCache' ? cacheSwitchResultNodes() : []),
      ),
    )
  }

  /**
   * 开关那一行的过程与结果（进行中 / 成功 / 失败）。没有可说的就返回空数组。
   *
   * 用数组返回，是为了能在 `h()` 的子节点列表里展开 —— 与 `spec.hint` 那处同样的写法。
   */
  function cacheSwitchResultNodes(): HTMLElement[] {
    if (cacheSwitch.kind === 'running') {
      return [
        h('div', {
          class: 'path',
          data: { state: 'running' },
          text: cacheSwitch.target ? '正在开启密文磁盘缓存…' : '正在关闭密文磁盘缓存…',
        }),
      ]
    }

    if (cacheSwitch.kind === 'done') {
      const cleanup =
        cacheSwitch.pendingCleanup > 0
          ? `还有 ${cacheSwitch.pendingCleanup} 个文件将在下次启动时清理。`
          : ''

      return [
        h('div', {
          class: 'path',
          data: { state: 'ok' },
          text: cacheSwitch.enabled
            ? `已开启：第二次打开同一个文件不再联网。${cleanup}`
            : `已关闭：${cacheSwitch.converted} 个缓存文件已清掉（只影响速度）。${cleanup}`,
        }),
      ]
    }

    if (cacheSwitch.kind !== 'failed') return []

    /**
     * 回滚成功与回滚失败**不是一回事**：前者状态一点没变、用户什么都不用做；后者两侧都
     * 可能留有文件，必须提示核对。开启方向那句还要更小心一点：那个方向删掉的是永远命不中
     * 的残留，"回滚成功"指的是**设置没写、缓存里可用的条目一个没少**。
     */
    const tail = cacheSwitch.rolledBack
      ? cacheSwitch.target
        ? '状态未变，缓存里可用的条目一个都没少。'
        : '状态未变，缓存文件一个都没少。'
      : '⚠️ 部分文件可能仍留在暂存区，请核对后再继续使用。'

    return [
      h('div', {
        class: 'path',
        data: { state: 'error' },
        text: `切换失败：${describeCacheSwitchFailure(cacheSwitch.failure, cacheSwitch.detail)}${tail}`,
      }),
    ]
  }

  /**
   * 容量项。
   *
   * **能改的判据是"它真的会被执行"**（[`SIZE_LIMIT_ENFORCED`]）：已实现的那一项（今天的
   * 归档上限，[ADR-0048]）解除禁用、改动即时提交；还没实现的那一项仍**禁用** —— 一个能改但
   * 不起作用的输入框，比一个明确标注"尚未生效"的输入框糟得多。禁用与徽标因此来自**同一个**
   * 布尔值，不会出现"能改却不会执行"或"会执行却改不了"这两种半截状态。
   *
   * 三种状态（不限制 / 设了但不会执行 / 生效中）由 `describeSizeLimit()` 算出来 —— 徽标与
   * 提示都跟着当前值走，因此不会出现"配置是不限制，却标着尚未生效"这种与配置无关的话。
   *
   * 视觉上有一处刻意的统一：值与其单位（GB）在同一行，不限制时输入框留空、由占位符说明，
   * 于是"输入框"与"提示"对同一件事只有一种说法。
   */
  function sizeRow(spec: SizeSpec, current: Settings): HTMLElement {
    const state = describeSizeLimit(spec.key, current[spec.key])
    const editable = SIZE_LIMIT_ENFORCED[spec.key]

    const input = h('input', {
      type: 'number',
      value: state.inputValue,
      placeholder: '不限制',
      disabled: !editable,
      title: state.badge ?? (state.unlimited ? '不限制' : '生效中'),
      // 清空输入框 = 不限制（`sizeLimitBytesFromInput()` 把空串解释成 0），因此这一行
      // 与"怎么取消上限"只有一种说法。
      ...(editable
        ? {
            onChange: (event: Event) => {
              const bytes = sizeLimitBytesFromInput((event.target as HTMLInputElement).value)
              void patch({ [spec.key]: bytes } as Partial<Settings>)
            },
          }
        : {}),
    })

    return h(
      'div',
      { class: 'setting', data: { pending: String(state.badge !== null) } },
      h(
        'div',
        { class: 'size-input' },
        input,
        // 单位必须写出来：一个孤零零的「2」到底是 2 个字节还是 2 GB，用户只能猜。
        h('span', { class: 'unit', text: 'GB' }),
      ),
      h(
        'div',
        {},
        h(
          'div',
          { class: 'label' },
          spec.label,
          ...(state.badge === null ? [] : [h('span', { class: 'badge', text: state.badge })]),
        ),
        h('div', { class: 'hint', text: state.hint }),
      ),
    )
  }

  /**
   * 「关于」那一行：应用名与版本。
   *
   * 这一行**没有可改的东西**（因此没有 `.actions`）—— 它回答的是"我装的到底是哪一个"，
   * 而这个问题在别处没有答案：安装包会被改名、托盘与启动器里都不显示版本号。
   *
   * 版本读不到时显示破折号，而不是编一个：用户会把这个值抄进 issue 里，错的版本号比
   * 没有版本号更坏。它不是设置项，因此也不该长成一个开关的样子。
   */
  function aboutRow(): HTMLElement {
    return h(
      'div',
      { class: 'setting' },
      h(
        'div',
        { class: 'meta' },
        h('div', { class: 'label', text: instanceInfo?.label ?? APP_DISPLAY_NAME }),
        h('div', { class: 'path', data: { role: 'version' }, text: appVersion ?? '—' }),
        /**
         * 命名实例在这里说清"我是独立的一份数据"。
         *
         * 这是**唯一**会明说这件事的地方：窗口标题只写了实例名，而"实例名意味着登录态、
         * 归档、设置、缓存都不共享"是用户看不到也猜不到的部分 —— 他更可能以为只是一个
         * 标签。
         */
        ...(instanceInfo !== null && !instanceInfo.isDefault
          ? [
              h('div', {
                class: 'hint',
                text: '这是一个独立实例：它的登录态、设置、归档与密文缓存都在各自的目录里，与其它实例互不可见。',
              }),
            ]
          : []),
      ),
    )
  }

  /**
   * 迁移进度是**主进程推过来的**。
   *
   * 不轮询：迁移可能只持续几百毫秒，轮询要么错过过程、要么白跑一堆 IPC。
   */
  const disposeMigration = bridge().onArchiveMigration((progress) => {
    location = { kind: 'running', progress }
    render()
  })

  /**
   * 词典的下载状态也是主进程推过来的（[ADR-0071]）。推的是**整张快照**，因此这里直接换掉
   * 那一份就够 —— 不需要增量合并，也就不会出现"两边各记一半"的状态。
   *
   * ⚠️ 它会让 `render()` 重画整棵子树，而 `⋯` 菜单挂在行元素里面：菜单开着时来了一个事件，
   * 菜单会被收掉（[ADR-0070] 那条"已知限制"因此不再是形状上的）。代价可接受 —— 事件只在
   * 下载的那几十秒里来几次，而那期间用户多半正盯着进度条看。
   */
  const disposeDictionaryStatus = bridge().onDictionaryStatusChange((statuses) => {
    dictionaryStatuses = statuses
    render()
  })

  /**
   * 设置也可能被**主进程自己**改掉（[ADR-0079]）：菜单里的放大 / 缩小 / 实际大小不经过这一页，
   * 而「界面缩放」那一行必须跟着变 —— 否则它会显示一个陈旧的值，用户再看它一眼只会更糊涂
   * （"我明明按住 `Ctrl` 放大了三次"）。
   *
   * 推来的是整份设置，因此直接换掉就够（与词典状态那一条同样的处理）。
   */
  const disposeSettingsChanged = bridge().onSettingsChanged((next) => {
    settings = next
    render()
  })

  return {
    async refresh(): Promise<void> {
      /**
       * 并行取：三者互不依赖，串行只会让窗口晚一点画出内容。
       *
       * 每次刷新都重新读一次图标状态，而不是只在挂载时读 —— 图标文件可能被外部删掉
       * （主进程读到坏文件就会清掉它），那时界面必须跟着回到"默认图标"。
       *
       * 后两者取不到时各自退化为"没有自定义图标"与"版本未知"：某一行的问题不该把**别的**
       * 行也带走 —— 让整个设置页空掉，用户连保存位置都看不到。
       */
      const [nextSettings, nextIcon, nextVersion, nextInstance, nextRestartState, nextStatuses] =
        await Promise.all([
          bridge().getSettings(),
          bridge()
            .getAppIcon()
            .catch(() => null),
          /**
           * 版本失败同样只影响它自己那一行（界面显示破折号）—— 一条元数据取不到，
           * 不该把整扇设置窗口带走。
           */
          bridge()
            .getAppVersion()
            .catch(() => null),
          bridge()
            .getInstanceInfo()
            .catch(() => null),
          readRestartState(),
          /**
           * 词典状态同理：读不到就按"这一格还没有状态"渲染。它不能跟着 `settings` 一起失败
           * （两者在同一个 `Promise.all` 里），否则一次 IPC 抖动会让整页设置消失。
           */
          bridge()
            .getDictionaryStatuses()
            .catch(() => ({})),
        ])

      settings = nextSettings
      appIcon = nextIcon
      appVersion = nextVersion
      instanceInfo = nextInstance
      restartState = nextRestartState
      dictionaryStatuses = nextStatuses
      render()
    },

    dispose(): void {
      disposeMigration()
      disposeDictionaryStatus()
      disposeSettingsChanged()

      /**
       * 词典对话框挂在 `document.body` 上，不随 `root` 的重画消失 —— 窗口卸载时要自己收掉，
       * 否则它会留在正在卸载的文档里（连同里面那份没人再看得见的草稿）。`⋯` 菜单同理，
       * 而且它还挂着两条 `document` 监听器。
       */
      languageDialog?.remove()
      languageDialog = null
      closeLanguageMenu()
    },
  }
}
