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
  DEFAULT_UI_LANGUAGE,
  SPELLCHECK_LANGUAGES,
  UI_LANGUAGES,
  formatLanguageList,
  parseLanguageList,
} from '../../shared/language'
import { describeMigrationFailure, describeMigrationProgress } from '../../shared/migration'
import { SETTINGS_SECTIONS, type SettingsRowKey } from '../../shared/settings-sections'
import {
  SIZE_LIMIT_ENFORCED,
  describeSizeLimit,
  sizeLimitBytesFromInput,
  type SizeLimitKey,
} from '../../shared/size-limit'
import {
  RESTART_REQUIRED_SETTINGS,
  type AppIconState,
  type ArchiveMigrationProgress,
  type CacheSwitchFailure,
  type CacheSwitchResult,
  type MigrationFailure,
  type Settings,
} from '../../shared/types'
import type { InstanceInfo } from '../../shared/bridge'
import { APP_DISPLAY_NAME } from '../../shared/constants'
import { bridge } from '../bridge'
import { h } from '../dom'
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
   * 刚裁剪出来、主进程还没确认的那张图的预览。
   *
   * 它让"实时预览"成为可能：用户选完图立刻看到结果，而不是先等一次 IPC 往返。
   * 主进程确认后清空，改由 `appIcon.preview` 作为唯一来源。
   */
  let iconPreview: string | null = null

  /** 提交一次部分更新，并把返回的完整设置重新渲染。 */
  async function patch(change: Partial<Settings>): Promise<void> {
    settings = await bridge().setSettings(change)
    render()
  }

  function render(): void {
    if (settings === null) return

    const current = settings

    /**
     * 每个区域画成 `<section>` + 一个小标题。
     *
     * 区域不是装饰：容量上限离开它管辖的开关就读不懂（"2 GB"是给谁设的上限？），而小标题
     * 是用户扫视时的锚点。区域与行序都来自 `shared/settings-sections.ts`。
     */
    root.replaceChildren(
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
    if (key === 'uiLanguage') return languageRow(current)
    if (key === 'spellcheckLanguages') return spellcheckLanguagesRow(current)

    const toggle = TOGGLES.find((spec) => spec.key === key)
    if (toggle !== undefined) return toggleRow(toggle, current)

    const size = SIZES.find((spec) => spec.key === key)
    if (size !== undefined) return sizeRow(size, current)

    throw new Error(`ui: 设置项 ${key} 在 ROW_ORDER 里，却没有对应的渲染`)
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
   * 界面语言那一行。
   *
   * 它改的是**会话的 `Accept-Language`**（[ADR-0060]），因此生效方式与别的设置项都不一样：
   * 主进程在提交之后会**重新加载内嵌页面**。这件事必须写在提示里 —— "切换语言会丢掉还没发
   * 出去的文字"如果不说，用户只会觉得是自己按错了。
   *
   * 选中项取设置值；设置值不在表里时（手工改坏的配置文件）**显示默认项**而不是"什么都不选"。
   * 后者会得到一行"界面说 A、实际按 B 跑"，而 `main/settings.ts` 的 `coerce()` 本来就会把这种
   * 值收敛掉 —— 这里只是不让界面在收敛之前显示成自相矛盾的样子。
   */
  function languageRow(current: Settings): HTMLElement {
    const chosen = UI_LANGUAGES.some((entry) => entry.code === current.uiLanguage)
      ? current.uiLanguage
      : DEFAULT_UI_LANGUAGE

    const select = h(
      'select',
      {
        class: 'language-select',
        onChange: (event) => {
          void patch({ uiLanguage: (event.target as HTMLSelectElement).value })
        },
      },
      ...UI_LANGUAGES.map((entry) =>
        h('option', {
          value: entry.code,
          selected: entry.code === chosen,
          text: entry.label,
        }),
      ),
    )

    return h(
      'div',
      { class: 'setting' },
      select,
      h(
        'div',
        {},
        h('div', { class: 'label', text: '界面语言' }),
        h('div', {
          class: 'hint',
          text: '内嵌页面的显示语言。切换后会重新加载页面 —— 输入框里还没发出去的文字会丢失。',
        }),
      ),
    )
  }

  /**
   * 拼写检查的词典那一行。
   *
   * 做成**复选框表**而不是 `<select multiple>`：多选下拉要按住 Ctrl 才能勾第二项，而这是一件
   * 没人会去猜的事。
   *
   * 两处禁用都是有话要说的（因此带 `title`，与"尚未生效"那个徽标同一个说法）：
   *
   *   - 拼写检查关着时整行禁用 —— 一份"给谁查"的清单离开了那个开关就读不懂；
   *   - **只剩一门时那一门本身禁用** —— 一门都不勾等于"什么都不查"，而它与"功能坏了"在用户
   *     看来没有区别。要停用整个功能，请用上面那个开关（它同时还意味着不去下载词典）。
   */
  function spellcheckLanguagesRow(current: Settings): HTMLElement {
    const checked = new Set(parseLanguageList(current.spellcheckLanguages))
    const off = !current.spellcheck

    const boxes = SPELLCHECK_LANGUAGES.map((entry) => {
      const onlyOne = checked.has(entry.code) && checked.size === 1
      const title = off ? '拼写检查已关闭' : onlyOne ? '至少要留一门词典' : null

      return h(
        'label',
        title === null ? {} : { title },
        h('input', {
          type: 'checkbox',
          checked: checked.has(entry.code),
          disabled: off || onlyOne,
          onChange: (event) => {
            const next = new Set(checked)
            if ((event.target as HTMLInputElement).checked) next.add(entry.code)
            else next.delete(entry.code)

            // 按**表**的顺序写回：勾选的先后不该改变存下来的值，否则同一组勾选会有多种写法，
            // 而"设置没变、值却变了"会让将来每一次比较都不可靠。
            const codes = SPELLCHECK_LANGUAGES.filter((item) => next.has(item.code)).map(
              (item) => item.code,
            )

            void patch({ spellcheckLanguages: formatLanguageList(codes) })
          },
        }),
        entry.label,
      )
    })

    return h(
      'div',
      { class: 'setting' },
      h('div', { class: 'languages' }, ...boxes),
      h(
        'div',
        {},
        h('div', { class: 'label', text: '拼写检查的词典' }),
        h('div', {
          class: 'hint',
          text: '勾了哪几门就查哪几门。词典由内核按需下载，没勾的语言不参与标注。',
        }),
      ),
    )
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
                text: `这一项归默认实例管：它对应的系统条目全机只有一份，两个实例同时改会互相覆盖。要开机启动这个实例，请单独做一个启动器条目（带 ${'--instance'} 参数）。`,
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
      const [nextSettings, nextIcon, nextVersion, nextInstance] = await Promise.all([
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
      ])

      settings = nextSettings
      appIcon = nextIcon
      appVersion = nextVersion
      instanceInfo = nextInstance
      render()
    },

    dispose(): void {
      disposeMigration()
    },
  }
}
