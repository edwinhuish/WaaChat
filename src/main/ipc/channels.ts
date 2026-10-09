/**
 * IPC 通道名。
 *
 * 主进程与渲染进程**共享本文件**，任何地方都不得出现通道名的字符串字面量 ——
 * 拼错一个通道名的典型症状是"调用没有反应也没有报错"，排查成本远高于多写一个常量。
 *
 * 命名约定：`<领域>:<动作>`。
 */

export const CHANNELS = {
  /** 查询归档（支持文件名搜索）。 */
  archiveList: 'archive:list',
  /** 取单条归档记录。 */
  archiveGet: 'archive:get',
  /** 把归档中的某个文件交给系统默认应用打开。只接受主进程产生的 id，不接受路径。 */
  archiveOpen: 'archive:open',
  /** 在文件管理器中显示。同样只接受 id。 */
  archiveReveal: 'archive:reveal',
  /** 归档统计（文件数、占用空间）。 */
  archiveStats: 'archive:stats',

  /** 读取设置。 */
  settingsGet: 'settings:get',
  /** 写入设置（部分更新）。 */
  settingsSet: 'settings:set',
  /**
   * 弹系统对话框让用户挑一个归档目录，确认后把数据迁移过去。
   *
   * **不接受任何参数**：目录只能由主进程的对话框产生。让渲染进程传一个路径进来
   * 等于把"设置任意目录为归档位置"这个本地副作用交给界面（见 ai/CONVENTIONS.md 第 6 节）。
   */
  archiveDirPick: 'archive:pick-dir',
  /** 归档迁移进度（主进程 → 渲染进程的单向推送）。 */
  archiveMigration: 'archive:migration',

  /** 读取接管健康状态。 */
  captureHealth: 'capture:health',
  /** 接管健康状态发生变化（主进程 → 渲染进程的单向推送）。 */
  captureHealthChanged: 'capture:health-changed',
} as const

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS]
