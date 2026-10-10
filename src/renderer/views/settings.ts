/**
 * 偏好设置。
 *
 * 三条原则：
 *
 *  1. **改动即时生效，不设「保存」按钮。** 每个开关独立提交，回填主进程返回的
 *     完整设置 —— 界面显示的就是实际生效的，不存在"我改了但它没生效"这种模糊状态。
 *  2. **没实现的项不假装能用，但状态要说的是"你当前的配置"。** `cacheMaxBytes` 的容量控制
 *     还没实现（见 docs/roadmap.md M3），因此它渲染成**禁用的**控件；`archiveMaxBytes`
 *     已经真的会被执行（[ADR-0048]），于是它是可改的。禁用与否只能由
 *     `shared/size-limit.ts` 的 `SIZE_LIMIT_ENFORCED` 决定 —— 一个能改但不起作用的开关，
 *     比一个明确标注"尚未生效"的开关糟得多，前者会让用户相信一件不成立的事。但徽标本身
 *     也不该是一句写死的话：**"不限制"时没有失效可言**（字面意思就是不清理），只有"设了
 *     上限却不会被执行"才需要警告。因此状态由 `describeSizeLimit()` 按"当前值 + 今天是否
 *     真的执行"算出来，而不是写在这一行里 —— 功能落地时改一个布尔值就够，不会留下一句
 *     过期的话。
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
import { bridge } from '../bridge'
import { h } from '../dom'
import { cropToAppIcon } from '../icon'

/** 只挑出 `Settings` 里的布尔字段，新增布尔项时编译器会在这里报错提醒补描述。 */
type BooleanKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings]

interface ToggleSpec {
  readonly key: BooleanKey
  readonly label: string
  readonly hint: string
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
    key: 'disablePdfPreview',
    label: '禁用 PDF 预览',
    /**
     * ⚠️ 这段说明在 [ADR-0041] 里被**实测**纠过一次，别再照直觉改回去：开启之后 PDF 确实不再
     * 交给内核阅读器（一律走下载），但**上游那个预览面板仍然会打开** —— 它是页面自己的界面，
     * 不注入就改不了（[INV-1]），而里面那份内容被我们挡掉了，于是它停在加载态。因此这一段必须
     * 同时说清"它不做什么"和"你该怎么做"，否则用户看到的就是"点了没反应"。
     */
    hint: '默认关闭：PDF 在上游的预览页里打开。开启后 PDF 不再交给内核阅读器 —— 一律走下载，文件归档后用系统默认阅读器打开。受端到端加密所限，"取文件"这一步得由你自己发起：点消息上的「下载」（会弹一条提示），或者在「文件列表」里找已经下载过的。注意：上游的预览面板仍会打开，但它拿不到内容、会停在加载态 —— 那是页面自己的界面，本应用无法让它不出现。',
  },
  {
    key: 'prefetch',
    label: '后台预取文档',
    hint: '收到文件类消息时提前拉取密文，点开更快。尚未实现（计划 M3）。',
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
          text: '窗口与托盘图标立即生效。启动器 / 任务栏图标由桌面环境缓存，要重新登录桌面（或注销再进来）之后才会更新。',
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

  function toggleRow(spec: ToggleSpec, current: Settings): HTMLElement {
    const needsRestart = RESTART_REQUIRED_SETTINGS.includes(spec.key)
    // 转换期间禁用**这一个**开关：再拨一次只会撞上主进程的闸门。别的开关不受影响。
    const switching = spec.key === 'enableCiphertextCache' && cacheSwitch.kind === 'running'

    const checkbox = h('input', {
      type: 'checkbox',
      checked: current[spec.key],
      disabled: switching,
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
       * 并行取：两者互不依赖，串行只会让窗口晚一点画出内容。
       *
       * 每次刷新都重新读一次图标状态，而不是只在挂载时读 —— 图标文件可能被外部删掉
       * （主进程读到坏文件就会清掉它），那时界面必须跟着回到"默认图标"。
       *
       * 图标状态取不到时退化为"没有自定义图标"：这一行的问题不该把**别的**行也带走 ——
       * 让整个设置页空掉，用户连保存位置都看不到。
       */
      const [nextSettings, nextIcon] = await Promise.all([
        bridge().getSettings(),
        bridge()
          .getAppIcon()
          .catch(() => null),
      ])

      settings = nextSettings
      appIcon = nextIcon
      render()
    },

    dispose(): void {
      disposeMigration()
    },
  }
}
