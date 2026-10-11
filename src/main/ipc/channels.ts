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
  /**
   * 批量导出到用户选的目录（[ADR-0050]）。
   *
   * 参数是一串**记录 id**。目录**不从这里进来**：它只能由主进程的对话框产生
   * （见 `archiveDirPick` 与 ai/CONVENTIONS.md 第 6 节），否则等于把"往任意路径写文件"
   * 交给界面。导出是**复制**，归档里那份一个字节都不动。
   */
  archiveExport: 'archive:export',
  /**
   * 批量删除（[ADR-0053]）。
   *
   * 同样只接受一串记录 id。主进程会先弹确认框 —— 这一步**不可逆**（磁盘上的正文也会被删），
   * 因此确认框是流程的一部分，不是装饰。
   */
  archiveDelete: 'archive:delete',

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

  /**
   * 应用版本（`app.getVersion()`，即打包时那份 `package.json` 的 `version`）。
   *
   * 只读、无参数、无副作用。设置窗口的「关于」区域显示它：用户报问题时第一句总是
   * "你用哪个版本"，而在它出现之前，界面里根本没有这个答案 —— 只能靠安装包文件名去猜。
   */
  appVersion: 'app:version',

  /**
   * 当前进程是哪个实例（多实例，[ADR-0062]）。
   *
   * 只读、无参数、无副作用。设置窗口的「关于」区域显示它，并据此把"只有默认实例能设"的
   * 那几项标出来 —— **界面必须知道自己在哪个实例里**，否则一个命名实例会显示着可以改的
   * 开机自启开关，而那个开关实际上是另一个实例管的。
   */
  instanceInfo: 'app:instance',

  /**
   * 有改动**还没生效**（[ADR-0064]）。
   *
   * 只读、无参数、无副作用。界面据此决定要不要显示那颗按钮 —— 常驻一个按钮是噪音，而在改过
   * 之后什么都不说会让用户以为这一项已经生效了。事实源在主进程：只有它知道"进程启动时读到的
   * 设置是什么"。
   */
  restartState: 'app:restart-state',

  /**
   * 重启应用（[ADR-0064]）。
   *
   * **不接受任何参数**：它一个字节的输入都不需要，"重启"这个动作本身也没有可调之处。
   * 与 `appIconSet` 之类一样，界面能表达的只有"我要这个"。
   *
   * ⚠️ 这是**唯一**会让应用自己退出的界面动作，因此它的配套要求写在 `main/restart.ts`：
   * 必须走 `app.quit()`（不是 `exit()`），否则退出清理会被跳过。
   *
   * ⚠️ 当前 `RESTART_REQUIRED_SETTINGS` **是空的**（[ADR-0066] 撤掉了它唯一的成员「界面语言」），
   * 因此界面上那颗「立即重启」暂时不会出现。通道保留：判据、实现与实测结论都在（见 `restart.ts`
   * 的文件头），而"这一项要重启"是很容易再出现的性质。
   */
  restart: 'app:restart',
} as const

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS]
