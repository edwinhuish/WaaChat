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
  /**
   * 切换密文磁盘缓存（开启 / 关闭），一次调用跑完整条事务式流程。
   *
   * 参数是一个布尔值 —— 这里唯一接受的"值"参数：它没有任何路径或标识可用，
   * 只会清掉**我们自己的**缓存目录里的派生数据，并且必须伴随一次真实转换（[ADR-0027]）。
   * `settings:set` 改不动这个开关。
   *
   * 没有配套的进度推送通道：切换是瞬时的、界面也不再有进度屏（[ADR-0028]）。
   */
  cacheSwitch: 'settings:switch-ciphertext-cache',

  /** 读取自定义图标状态（是否启用、预览、启动器条目）。 */
  appIconGet: 'appicon:get',
  /**
   * 弹系统对话框让用户挑一张图片。
   *
   * **不接受任何参数**，与 `archiveDirPick` 同一条理由：路径只能由主进程的对话框产生。
   * 返回的是**字节**而不是路径 —— 渲染进程拿数据去解码，落盘位置仍由主进程决定。
   */
  appIconPick: 'appicon:pick',
  /** 提交已裁剪好的 PNG 字节（渲染进程的 canvas 产出的那张）。 */
  appIconSet: 'appicon:set',
  /** 恢复默认图标：删掉自定义图标与**我们自己写的**启动器条目。 */
  appIconReset: 'appicon:reset',
} as const

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS]
