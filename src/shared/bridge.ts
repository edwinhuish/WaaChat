/**
 * 渲染进程能看到的**全部**本地能力。
 *
 * 这是渲染侧唯一的 API 面（挂在 `window.waachat` 上，由 `src/preload/index.ts` 实现）。
 * 把它放在 `shared/` 而不是 preload 里，是因为**渲染进程要能类型检查它** ——
 * 渲染进程的 tsconfig 不允许 import electron，而 preload 的实现必然 import 它。
 * 于是"能力清单"与"能力实现"必须分居两处，前者是纯类型。
 *
 * 设计原则（`ai/CONVENTIONS.md` 第 6 节）：
 *
 *   - 参数只接受**主进程产生的标识**（记录 id），永远不接受路径、URL、命令。
 *   - 没有"执行任意操作"的通用入口（没有 `invoke(channel, ...args)` 这种反射式桥）。
 *     反过来说：**新增一个能力 = 新增一个具名方法 + 一条通道**，没有捷径可走。
 *   - 数据只从主进程流向界面（读）。写操作有五个，**都不接受路径**：改设置（白名单字段）、
 *     提交一张已裁剪好的图标（纯字节，落盘位置由主进程决定）、把选中的记录导出到**对话框
 *     选出的**目录（[ADR-0050]）、从归档删除选中的记录（[ADR-0053]），以及重启应用
 *     （[ADR-0064]，连参数都没有）—— 它们的目标与对象都由主进程自己确定，渲染进程送进来的
 *     只有记录 id（或什么都不送）。
 */

import type {
  AppIconInput,
  AppIconPickResult,
  AppIconResult,
  AppIconState,
  ArchiveDeleteResult,
  ArchiveExportResult,
  ArchiveMigrationProgress,
  ArchiveMigrationResult,
  ArchiveQuery,
  ArchiveRecord,
  ArchiveStats,
  CacheSwitchResult,
  OpenOutcome,
  RestartState,
  RevealOutcome,
  Settings,
} from './types'

/** 按 id 操作归档记录时的入参。刻意用对象而不是裸数字，便于将来加字段而不破坏签名。 */
export interface ArchiveIdInput {
  readonly id: number
}

/**
 * 按**一串** id 操作时的入参（批量导出 / 批量删除）。
 *
 * 与 {@link ArchiveIdInput} 同样的理由，外加一条：数组让"批量"这个意图在类型上就看得见 ——
 * 主进程据此做上限检查，界面也据此判断按钮该不该亮。
 */
export interface ArchiveIdsInput {
  readonly ids: readonly number[]
}

export interface WaaChatBridge {
  // --- 归档 -----------------------------------------------------------------

  /** 列出/搜索归档记录。 */
  listArchive(query?: ArchiveQuery): Promise<ArchiveRecord[]>
  /** 取单条记录。不存在时返回 `null`，不抛错。 */
  getArchive(input: ArchiveIdInput): Promise<ArchiveRecord | null>
  /** 交给系统默认应用打开。 */
  openArchive(input: ArchiveIdInput): Promise<OpenOutcome>
  /** 在文件管理器中定位（归档是内容寻址的，用户自己在磁盘上找不到）。 */
  revealArchive(input: ArchiveIdInput): Promise<RevealOutcome>
  /** 归档占用统计。 */
  archiveStats(): Promise<ArchiveStats>
  /**
   * 把选中的记录**复制**到用户挑的目录（[ADR-0050]）。
   *
   * 三种结果：导出完成（可能部分失败，`failed` 逐条给出）、整次调用被拒绝（`ok: false`）、
   * 以及 `null` —— 用户在目录对话框里**取消**。取消不是错误，界面不该留下任何痕迹。
   *
   * 渲染进程只能传 id：目录由主进程的对话框产生。**归档里那份一个字节都不动**。
   */
  exportArchive(input: ArchiveIdsInput): Promise<ArchiveExportResult | null>
  /**
   * 把选中的记录**从归档里删掉**（[ADR-0053]）。
   *
   * 同样三种结果，`null` 这次表示用户在**确认框**里取消。删除**不可逆** —— 磁盘上的正文也会
   * 被删除（需要时重新在聊天里点一次即可再次归档），因此主进程一定会先确认。
   *
   * ⚠️ 删的是**选中的那些行**：同一份内容被别的消息引用时，那些消息里的那一份不受影响
   * （[ADR-0052] 的硬链接）。因此删除**未必**会减少占用。
   */
  deleteArchive(input: ArchiveIdsInput): Promise<ArchiveDeleteResult | null>

  // --- 设置 -----------------------------------------------------------------

  getSettings(): Promise<Settings>
  /**
   * 部分更新设置，返回更新后的完整设置。
   *
   * 返回完整值而不是 `void`：界面不需要自己维护"我改了什么"的状态，
   * 也就不会出现"界面显示的状态与实际生效的状态不一致"。
   */
  setSettings(patch: Partial<Settings>): Promise<Settings>
  /**
   * 有改动但**还没生效**（[ADR-0064]）。
   *
   * 只读。界面据此决定要不要显示那颗按钮：常驻一个按钮是噪音，而改过之后什么都不说，
   * 用户会以为这一项已经生效了。
   */
  getRestartState(): Promise<RestartState>
  /**
   * 重启应用（[ADR-0064]）。
   *
   * **不接受参数**，也**没有结果**：调用之后进程就开始退出，`await` 到什么都不代表"已经重启好了"。
   * 这一步走的是与托盘「退出」**同一条**退出路径（"退出时清除归档"之类的收尾照常执行），
   * 然后带着原来的命令行参数重新启动（`--instance work` 因此会被带过去）。
   */
  restart(): Promise<void>
  /**
   * 更换归档的保存位置：选目录 → 确认 → 迁移数据 → 切换。
   *
   * 三种结果：迁移成功（含更新后的设置与规模）、失败（含原因与是否已回滚）、
   * 以及 `null` —— 用户在**任一步**取消。取消不是错误，界面不该留下任何痕迹。
   *
   * 渲染进程**不能**传路径进来：目录只能由主进程的对话框产生（ai/CONVENTIONS.md 第 6 节）。
   */
  pickArchiveDir(): Promise<ArchiveMigrationResult | null>
  /**
   * 订阅迁移进度。
   *
   * 迁移可能是几十 GB，界面必须能说清"到哪了"。返回取消订阅函数 —— 不返回的话，
   * 界面每次重新挂载都会多留一个监听器。
   */
  onArchiveMigration(listener: (progress: ArchiveMigrationProgress) => void): () => void

  /**
   * 切换密文磁盘缓存。
   *
   * `target` 是用户拨向的那一边。主进程会在一次事务里转换缓存文件，全部成功之后才提交
   * 设置（[ADR-0027]）。**没有确认框，也没有进度订阅**：这个调用会一直等到切换结束
   * （[ADR-0028]），因此界面只需要处理它的返回值。
   *
   * 三种结果：成功（含更新后的设置与规模）、失败（含原因与是否已回滚）、以及 `null` ——
   * 开关已经是目标状态，这次调用什么都没做。它不是错误。
   */
  switchCiphertextCache(target: boolean): Promise<CacheSwitchResult | null>

  // --- 应用图标 --------------------------------------------------------------

  /** 读取自定义图标状态（是否启用、预览数据 URL、启动器条目是否已写入）。 */
  getAppIcon(): Promise<AppIconState>

  /**
   * 弹系统对话框让用户挑一张图片，返回**原文件字节**。
   *
   * `null` 表示用户取消 —— 与失败分开：取消不是错误，界面不该留下任何痕迹。
   *
   * 传字节而不是路径：路径是能力，字节只是数据。解码与裁剪在界面侧完成（只有 Chromium
   * 认得 ICO 这类格式，见 ADR-0022），但**写到哪里始终由主进程决定**。
   */
  pickAppIcon(): Promise<AppIconPickResult | null>

  /**
   * 提交已经裁剪、缩放好的 PNG。
   *
   * 主进程会自己再解码一次来确认它确实是一张 512×512 的图 —— 渲染进程送进来的是**数据**，
   * 哪怕送它的是我们自己的代码。
   */
  setAppIcon(input: AppIconInput): Promise<AppIconResult>

  /** 恢复默认图标（同时删掉我们写的那份启动器条目）。 */
  resetAppIcon(): Promise<AppIconResult>

  // --- 应用 -----------------------------------------------------------------

  /**
   * 应用版本（`app.getVersion()`）。
   *
   * 设置窗口的「关于」区域显示它。**只读、无参数**：它不是"一个能力"，只是一条界面需要的
   * 元数据 —— 报问题时第一句总是"你用哪个版本"，而在此之前界面里没有这个答案。
   */
  getAppVersion(): Promise<string>

  /**
   * 当前进程是哪个实例（多实例，[ADR-0062]）。
   *
   * 界面需要它来回答两个问题：**我这个窗口属于哪一份数据**（「关于」里显示的实例名），
   * 以及**哪几项在这里改不了**（开机自启、启动器条目这类"全机一份"的东西归属默认实例）。
   *
   * 只读、无参数。它不是"一个能力" —— 主进程不会因为被问过就改任何状态。
   */
  getInstanceInfo(): Promise<InstanceInfo>
}

/**
 * 当前进程的实例标识。
 *
 * `id` 是空串表示**默认实例**（用户没指定 `--instance`），因此判断"是不是默认实例"必须
 * 看 {@link InstanceInfo.isDefault}，不要拿 `id` 与 `'default'` 比 —— 那个名字是**保留的**，
 * 永远不是一个真实实例的名字（见 `shared/instance.ts` 的 `RESERVED_INSTANCE_IDS`）。
 */
export interface InstanceInfo {
  /** 实例标识；空串表示默认实例。 */
  readonly id: string
  /** 界面上用来指代它的名字（`WaaChat` 或 `WaaChat（work）`）。 */
  readonly label: string
  /** 是不是默认实例。 */
  readonly isDefault: boolean
}
