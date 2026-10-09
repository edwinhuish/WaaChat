/**
 * contextBridge。
 *
 * 这一层的**唯一职责**是把 {@link WaaChatBridge} 里的具名方法接到 IPC 通道上。
 * 三条硬性约束：
 *
 *  1. **单向。** 暴露出去的都是具名的取数/提交方法，没有任何让渲染侧发起**任意**本地
 *     动作的入口（不暴露 `ipcRenderer`、不暴露 `shell`、不暴露通道名列表）。
 *     提交类方法（改设置、交图标字节）传的是值而不是路径 —— 路径是能力，值只是数据。
 *  2. **不做逻辑。** 任何判断、降级、校验都留在主进程。放在这里的逻辑会同时
 *     躲过主进程的测试与校验。
 *  3. **对象是冻结的。** 渲染侧的脚本（或将来误引入的第三方库）改不动它。
 *
 * 注意：这个 preload **只挂在本地界面窗口**上 —— 现在是两扇（文件列表 / 设置，
 * 见 ADR-0025），它们都是我们自己的内容。承载上游页面的窗口没有 preload
 * （见 `src/main/window.ts`），因此远程内容连这段代码的存在都无法触达 ——
 * 这是结构性保证，不是靠这里写对。
 */

import { contextBridge, ipcRenderer } from 'electron'

import type { ArchiveIdInput, WaaChatBridge } from '../shared/bridge'
import type {
  AppIconInput,
  ArchiveMigrationProgress,
  ArchiveQuery,
  CaptureHealth,
  Settings,
} from '../shared/types'
import { CHANNELS } from '../main/ipc/channels'

const bridge: WaaChatBridge = {
  listArchive: (query?: ArchiveQuery) => ipcRenderer.invoke(CHANNELS.archiveList, query),

  getArchive: (input: ArchiveIdInput) => ipcRenderer.invoke(CHANNELS.archiveGet, input),

  openArchive: (input: ArchiveIdInput) => ipcRenderer.invoke(CHANNELS.archiveOpen, input),

  revealArchive: (input: ArchiveIdInput) => ipcRenderer.invoke(CHANNELS.archiveReveal, input),

  archiveStats: () => ipcRenderer.invoke(CHANNELS.archiveStats),

  getSettings: () => ipcRenderer.invoke(CHANNELS.settingsGet),

  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke(CHANNELS.settingsSet, patch),

  pickArchiveDir: () => ipcRenderer.invoke(CHANNELS.archiveDirPick),

  getAppIcon: () => ipcRenderer.invoke(CHANNELS.appIconGet),

  pickAppIcon: () => ipcRenderer.invoke(CHANNELS.appIconPick),

  setAppIcon: (input: AppIconInput) => ipcRenderer.invoke(CHANNELS.appIconSet, input),

  resetAppIcon: () => ipcRenderer.invoke(CHANNELS.appIconReset),

  onArchiveMigration: (listener: (progress: ArchiveMigrationProgress) => void) => {
    /**
     * 与 `onCaptureHealthChanged` 同样的包装：直接把 `listener` 交给 `ipcRenderer.on`
     * 会把 Electron 的 `event`（带着 `sender`）作为第一个参数交给渲染侧代码。
     */
    const wrapped = (_event: unknown, progress: ArchiveMigrationProgress): void =>
      listener(progress)

    ipcRenderer.on(CHANNELS.archiveMigration, wrapped)

    return () => {
      ipcRenderer.removeListener(CHANNELS.archiveMigration, wrapped)
    }
  },

  switchCiphertextCache: (target: boolean) => ipcRenderer.invoke(CHANNELS.cacheSwitch, target),

  getCaptureHealth: () => ipcRenderer.invoke(CHANNELS.captureHealth),

  onCaptureHealthChanged: (listener: (health: CaptureHealth) => void) => {
    /**
     * 包一层再注册。
     *
     * 直接把 `listener` 交给 `ipcRenderer.on` 会把 Electron 的 `event` 作为第一个
     * 参数传过去 —— 那等于把一个 IPC 事件对象（带着 `sender`）交给渲染侧代码。
     * 只透传载荷，是这个包装存在的唯一原因。
     */
    const wrapped = (_event: unknown, health: CaptureHealth): void => listener(health)

    ipcRenderer.on(CHANNELS.captureHealthChanged, wrapped)

    return () => {
      ipcRenderer.removeListener(CHANNELS.captureHealthChanged, wrapped)
    }
  },
}

/** `Object.freeze` 挡的是渲染侧误改写；真正的边界是 contextIsolation 本身。 */
contextBridge.exposeInMainWorld('waachat', Object.freeze(bridge))
