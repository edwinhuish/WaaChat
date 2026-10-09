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
 *   - 数据只从主进程流向界面（读）。写操作只有两个，且都不接受路径：改设置（白名单字段），
 *     以及提交一张已裁剪好的图标（纯字节，落盘位置由主进程决定）。
 */

import type {
  AppIconInput,
  AppIconPickResult,
  AppIconResult,
  AppIconState,
  ArchiveMigrationProgress,
  ArchiveMigrationResult,
  ArchiveQuery,
  ArchiveRecord,
  ArchiveStats,
  CacheConversionProgress,
  CacheSwitchResult,
  CaptureHealth,
  OpenOutcome,
  RevealOutcome,
  Settings,
} from './types'

/** 按 id 操作归档记录时的入参。刻意用对象而不是裸数字，便于将来加字段而不破坏签名。 */
export interface ArchiveIdInput {
  readonly id: number
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
   * 迁移可能是几十 GB，界面必须能说清"到哪了"。返回取消订阅函数 —— 同
   * `onCaptureHealthChanged`：不返回的话，界面每次重新挂载都会多留一个监听器。
   */
  onArchiveMigration(listener: (progress: ArchiveMigrationProgress) => void): () => void

  /**
   * 切换密文磁盘缓存。
   *
   * `target` 是用户拨向的那一边。主进程会先弹确认框，再在**维护流程**里转换缓存文件，
   * 全部成功之后才提交设置（[ADR-0027]）。
   *
   * 三种结果：成功（含更新后的设置与规模）、失败（含原因与是否已回滚）、以及 `null` ——
   * 用户在确认框里取消（或已经是目标状态）。取消不是错误。
   */
  switchCiphertextCache(target: boolean): Promise<CacheSwitchResult | null>
  /**
   * 订阅切换进度。维护界面靠它显示"到哪了"。
   *
   * 返回取消订阅函数 —— 与 `onArchiveMigration` 同理：不返回的话，窗口每次重新挂载都会
   * 多留一个监听器。
   */
  onCacheConversion(listener: (progress: CacheConversionProgress) => void): () => void

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

  // --- 接管健康 --------------------------------------------------------------

  /** 主动查询一次。 */
  getCaptureHealth(): Promise<CaptureHealth>
  /**
   * 订阅变化。返回取消订阅函数 —— 不返回的话，界面重新挂载时会累积监听器，
   * 表现为"同一次接管弹出多次提示"。
   */
  onCaptureHealthChanged(listener: (health: CaptureHealth) => void): () => void
}
