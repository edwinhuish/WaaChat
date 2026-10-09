/**
 * 偏好设置。
 *
 * 三条原则：
 *
 *  1. **改动即时生效，不设「保存」按钮。** 每个开关独立提交，回填主进程返回的
 *     完整设置 —— 界面显示的就是实际生效的，不存在"我改了但它没生效"这种模糊状态。
 *  2. **没实现的项不假装能用。** `archiveMaxBytes` / `cacheMaxBytes` 的淘汰策略
 *     还没实现（见 docs/roadmap.md M2/M3），因此它们渲染成**禁用的**控件并说明原因。
 *     一个能改但不起作用的开关，比一个明确标注"尚未生效"的开关糟得多 ——
 *     前者会让用户相信一件不成立的事。
 *  3. **长任务要有过程。** 换保存位置会真的搬动整个归档库，因此它有确认框（主进程）、
 *     进度、成功与失败三种可见的结果 —— 用户不该对着一个没有反应的按钮猜发生了什么。
 */

import { describeMigrationFailure, describeMigrationProgress } from '../../shared/migration'
import {
  RESTART_REQUIRED_SETTINGS,
  type ArchiveMigrationProgress,
  type MigrationFailure,
  type Settings,
} from '../../shared/types'
import { formatBytes } from '../../shared/format'
import { bridge } from '../bridge'
import { h } from '../dom'

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
    hint: '把聊天文件的密文留在本地，第二次打开不再联网。不涉及解密，也不保存密钥。',
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
  readonly key: 'archiveMaxBytes' | 'cacheMaxBytes'
  readonly label: string
  readonly hint: string
}

const SIZES: readonly SizeSpec[] = [
  {
    key: 'archiveMaxBytes',
    label: '归档大小上限',
    hint: '淘汰策略尚未实现（计划 M2），此项暂时不生效。',
  },
  {
    key: 'cacheMaxBytes',
    label: '密文缓存上限',
    hint: '容量控制尚未实现（计划 M3），当前缓存只增不减。',
  },
]

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

export interface SettingsView {
  refresh(): Promise<void>
  /** 取消订阅迁移进度。窗口真正卸载时调用。 */
  dispose(): void
}

export function mountSettingsView(root: HTMLElement): SettingsView {
  let settings: Settings | null = null
  let location: LocationState = { kind: 'idle' }

  /** 提交一次部分更新，并把返回的完整设置重新渲染。 */
  async function patch(change: Partial<Settings>): Promise<void> {
    settings = await bridge().setSettings(change)
    render()
  }

  function render(): void {
    if (settings === null) return
    const current = settings

    root.replaceChildren(
      locationRow(current),
      ...TOGGLES.map((spec) => toggleRow(spec, current)),
      ...SIZES.map((spec) => sizeRow(spec, current)),
    )
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

    return h(
      'div',
      { class: 'setting' },
      h('button', {
        class: 'action',
        type: 'button',
        text: running ? '迁移中…' : '更改…',
        disabled: running,
        onClick: () => void pick(),
      }),
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

    const checkbox = h('input', {
      type: 'checkbox',
      checked: current[spec.key],
      onChange: (event) => {
        const checked = (event.target as HTMLInputElement).checked
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
      ),
    )
  }

  /**
   * 未实现的容量项：显示当前值，但**禁用**输入。
   *
   * 用 `data-pending` 触发降透明度的样式，让"这项还不可用"在视觉上也成立 ——
   * 光靠一行小字提示，用户还是会去点它。
   */
  function sizeRow(spec: SizeSpec, current: Settings): HTMLElement {
    const bytes = current[spec.key]
    const gigabytes = bytes === 0 ? 0 : Number((bytes / 1024 / 1024 / 1024).toFixed(1))

    const input = h('input', {
      type: 'number',
      value: String(gigabytes),
      disabled: true,
      title: '尚未生效',
    })

    return h(
      'div',
      { class: 'setting', data: { pending: 'true' } },
      input,
      h(
        'div',
        {},
        h('div', { class: 'label' }, spec.label, h('span', { class: 'badge', text: '尚未生效' })),
        h('div', {
          class: 'hint',
          text: `${spec.hint}当前值：${bytes === 0 ? '不限制' : formatBytes(bytes)}。`,
        }),
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
      settings = await bridge().getSettings()
      render()
    },

    dispose(): void {
      disposeMigration()
    },
  }
}
