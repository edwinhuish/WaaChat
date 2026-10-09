/**
 * 主进程与渲染进程共享的类型。
 *
 * 只放**数据形状**，不放实现。这里出现的类型不应该导入任何 Electron 类型 ——
 * 渲染进程也要能编译它。
 */

// ---------------------------------------------------------------------------
// 归档
// ---------------------------------------------------------------------------

/**
 * 一条归档记录。
 *
 * 注意这里**没有**会话名与消息内容。归档层的输入只有"一份文件 + 它是被谁在
 * 什么时候打开的"这种级别的元信息 —— 这是刻意的边界，原因见
 * docs/architecture.md 第 7 节。
 */
export interface ArchiveRecord {
  /** 主键，自增。IPC 只接受这个标识，不接受路径（见 ai/CONVENTIONS.md 第 6 节）。 */
  readonly id: number
  /** 内容哈希，同时是归档目录中的文件名。 */
  readonly hash: string
  /** 打开时的原始文件名，用于展示与导出时还原。 */
  readonly name: string
  readonly bytes: number
  readonly mime: string
  /** 归档时间（Unix 毫秒）。 */
  readonly openedAt: number

  /**
   * 会话的人类可读标签。
   *
   * 可选，因为来源不保证可得：我们不读取页面内部数据（INV-1），只能从下载
   * 事件与窗口标题等间接信息推断。拿不到就是 undefined，不要为此引入新的数据源。
   */
  readonly chatLabel?: string
}

/** 归档查询条件。 */
export interface ArchiveQuery {
  /** 文件名全文搜索（FTS5）。 */
  readonly text?: string
  readonly limit?: number
  readonly offset?: number
}

/** 归档的存储统计。 */
export interface ArchiveStats {
  readonly fileCount: number
  readonly totalBytes: number
  readonly cacheBytes: number
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

export interface Settings {
  /** 点击文件时是否直接交给系统默认应用打开。关闭则只归档。 */
  readonly openOnCapture: boolean
  /** 收到文件类消息时是否后台预取**密文**（不涉及解密）。 */
  readonly prefetch: boolean
  /** 退出时是否清除归档。共享机器上应开启。 */
  readonly wipeArchiveOnExit: boolean
  /**
   * 归档文件的保存位置。
   *
   * 空串表示"用默认位置"（`~/Documents/WhatsApp_files`）—— 默认值刻意不写死成绝对
   * 路径：`Settings` 是渲染进程也要编译的数据形状，而 `~/` 的展开只有主进程能做
   * （`shared/` 不得访问文件系统，见 ai/CONVENTIONS.md 第 2 节）。
   */
  readonly archiveDir: string
  /** 归档容量上限（字节）。0 表示不限制。 */
  readonly archiveMaxBytes: number
  /** 密文缓存容量上限（字节）。 */
  readonly cacheMaxBytes: number
  /**
   * 是否启用接管点 B（密文缓存）。关闭后行为等同于只有接管点 A。
   *
   * **默认开启**（[ADR-0028]）：缓存里存的始终是**上游已经加密好的那份字节** —— 本应用
   * 不参与任何加解密（[INV-3]），因此它单独泄露的危害低于归档里的明文（`docs/security.md`）。
   * 换来的是一次网络往返：同一个文件第二次打开不再联网。
   *
   * 改它**不需要重启**：提交那一刻协议层就跟着挂上或摘掉（[ADR-0027]）。启动时仍会把缓存
   * 目录对账到当前设置（关闭 → 清掉已有条目；开启 → 保留可命中的条目）。
   */
  readonly enableCiphertextCache: boolean
  /** 是否随桌面会话自启动。 */
  readonly launchAtLogin: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  openOnCapture: true,
  prefetch: false,
  wipeArchiveOnExit: false,
  archiveDir: '',
  archiveMaxBytes: 0,
  cacheMaxBytes: 2 * 1024 * 1024 * 1024,
  enableCiphertextCache: true,
  launchAtLogin: false,
}

/**
 * 哪些设置**需要重启**才能生效。
 *
 * 界面对照这个列表渲染"重启后生效"的徽标，不自己写死。
 *
 * **目前是空的**：唯一在册的 `enableCiphertextCache` 改成了事务式切换（[ADR-0027]）——
 * 提交设置的同时把协议层一起注册/注销，因此它提交即生效。列表与徽标机制**保留**：
 * 它是"某项改不动"这件事唯一的表达方式，将来还可能有别的项进来（例如需要重建分区的设置）。
 *
 * 历史：这个列表最初只有 `enableCiphertextCache`，理由是 `ses.protocol.handle('https')`
 * 过去只在启动时注册一次、之后不再变。现在那层跟着设置走，理由随之消失。
 */
export const RESTART_REQUIRED_SETTINGS: readonly (keyof Settings)[] = []

// ---------------------------------------------------------------------------
// 归档迁移（更换保存位置）
// ---------------------------------------------------------------------------

/**
 * 迁移失败的结构化原因。
 *
 * 文案只有一份，在 `shared/migration.ts` —— 主进程要拿它填错误对话框，界面要拿它
 * 填状态行。各写一份的结果是同一个失败在两处措辞不同，用户会以为是两件事。
 */
export type MigrationFailure =
  /** 当前归档目录不见了或不是目录。 */
  | 'source-missing'
  /** 选中的位置存在，但不是目录（比如选到了一个文件）。 */
  | 'not-a-directory'
  /** 选中的目录里已经有东西。归档是内容寻址的单一库，不做合并。 */
  | 'target-not-empty'
  /** 新位置是当前归档目录本身、它的子目录、或它的上级目录。 */
  | 'nested-location'
  /** 归档目录里有搬不了的东西：符号链接、非点开头的目录等。 */
  | 'unexpected-content'
  /** 写新位置时失败（磁盘满、只读挂载、权限）。 */
  | 'write-failed'

/** 被迁移的内容规模。确认框要用它说清"要搬多少东西"。 */
export interface MigrationSummary {
  readonly files: number
  readonly bytes: number
}

/**
 * 迁移进度。
 *
 * 迁移可能是几十 GB（跨文件系统时会真的复制一遍），因此界面必须能说清"到哪了"，
 * 而不是让用户对着一个没有反应的按钮猜。
 */
export interface ArchiveMigrationProgress {
  /** `migrating` 搬条目；`finishing` 收尾（清派生物、删空的源目录、补搬并发写入）。 */
  readonly phase: 'migrating' | 'finishing'
  readonly done: number
  readonly total: number
  readonly bytesDone: number
  readonly bytesTotal: number
}

/**
 * 更换保存位置的结果。
 *
 * `null` 表示用户在**任一步**取消（选目录时取消、或在确认框里点取消）—— 与失败
 * 分开，因为"取消"不是错误，不该在界面上留下任何痕迹（见 `bridge.pickArchiveDir`）。
 */
export type ArchiveMigrationResult =
  | {
      readonly ok: true
      /** 更新后的完整设置（`archiveDir` 已指向新位置）。 */
      readonly settings: Settings
      readonly target: string
      readonly migrated: MigrationSummary
    }
  | {
      readonly ok: false
      readonly failure: MigrationFailure
      /** 给用户看的具体信息（路径、条目名）。**不要写进日志** —— 见 INVARIANTS G-3。 */
      readonly detail: string
      /**
       * 已经搬走的条目是否都放回了原位。
       *
       * `false` 意味着两侧都可能留有数据，界面必须让用户知道要人工核对 ——
       * 回滚**只做搬运，不做删除**，这是刻意的（见 `archive/migrate.ts`）。
       */
      readonly rolledBack: boolean
    }

// ---------------------------------------------------------------------------
// 密文缓存的切换（事务式维护流程，见 ADR-0027）
// ---------------------------------------------------------------------------

/**
 * 切换过程中的阶段。
 *
 * 顺序是固定的：先转换文件，再提交设置，最后清理。**提交是分界线** —— 提交之前失败会
 * 回退（设置一个字节都不写），提交之后只剩清理（失败也不回退，见 ADR-0027 的影响一节）。
 */
export type CacheConversionPhase =
  /** 搬条目进暂存区（关闭）或清掉不可能命中的残留（开启）。 */
  | 'converting'
  /** 写 `settings.json` —— 只有到这里才"正式切换"。 */
  | 'committing'
  /** 删掉暂存区（仅关闭方向）。 */
  | 'cleaning'

/** 转换进度（主进程 → 渲染进程的单向推送）。维护界面靠它显示"到哪了"。 */
export interface CacheConversionProgress {
  /** 目标状态：`true` 开启、`false` 关闭。 */
  readonly target: boolean
  readonly phase: CacheConversionPhase
  readonly done: number
  readonly total: number
  readonly bytesDone: number
  readonly bytesTotal: number
}

/**
 * 切换失败的结构化原因。文案在 `shared/cache-conversion.ts`。
 */
export type CacheSwitchFailure =
  /** 已经有一次切换在进行。正常路径下界面会挡住这种操作，这条是兜底。 */
  | 'busy'
  /** 读不了缓存目录（权限、被换成文件）。 */
  | 'unreadable'
  /** 搬条目或落设置时写盘失败（磁盘满、权限）。 */
  | 'write-failed'

/**
 * 一次切换的结果。
 *
 * `null`（不在这个类型里）表示用户取消了确认框 —— 与失败分开：取消不是错误，
 * 界面上不该留下任何痕迹。
 */
export type CacheSwitchResult =
  | {
      readonly ok: true
      /** 切换后的状态（等于用户拨向的那一边）。 */
      readonly enabled: boolean
      /** 更新后的完整设置。 */
      readonly settings: Settings
      /** 转换掉的条目数与字节数。 */
      readonly converted: number
      readonly bytes: number
      /**
       * 提交之后没能清理掉的条目数（正常为 0）。
       *
       * 不为 0 时状态**已经切过去了**，只是那些文件还在暂存区里占着磁盘，下次启动会清掉。
       * 界面必须说出来 —— 用户检查磁盘空间时唯一的线索就是这句。
       */
      readonly pendingCleanup: number
    }
  | {
      readonly ok: false
      readonly failure: CacheSwitchFailure
      /** 给用户看的具体信息。**不要写进日志**（INVARIANTS G-3）。 */
      readonly detail: string
      /**
       * 是否已经回到切换前的状态。`false` 时界面要提示人工核对。
       *
       * ⚠️ **开启方向**的 `true` 含义略有不同：那个方向删掉的是"正文与元信息缺一半"的
       * 残留，它们本来就永远命不中、也搬不回来。所以那里 `true` 指的是"设置一个字节都
       * 没写、缓存里可用的条目一个没少"，而不是"删掉的都回来了"。
       */
      readonly rolledBack: boolean
      /** 失败后仍然生效的设置（用来把界面复位到真实状态）。 */
      readonly settings: Settings
    }

// ---------------------------------------------------------------------------
// 接管的健康状态
// ---------------------------------------------------------------------------

/**
 * 接管是否还活着。
 *
 * 这不是 debug 信息 —— 它是**用户可见**的。沉默地退回原生下载是最坏的结果
 * （用户会以为文件没下载成功），因此这个状态必须能被界面读到。
 * 见 docs/architecture.md 第 5 节。
 */
export interface CaptureHealth {
  /** 最近一次成功接管的时间戳；从未成功过则为 null。 */
  readonly lastCaptureAt: number | null
  /** 最近一次落盘失败的原因，用于界面提示。 */
  readonly lastError: CaptureFailure | null
  /** 接管点 B（密文缓存）当前是否生效。 */
  readonly ciphertextCacheActive: boolean
}

export type CaptureFailure =
  | { readonly kind: 'download-event-missing' }
  | { readonly kind: 'write-failed'; readonly reason: string }
  | { readonly kind: 'open-failed'; readonly reason: string }
  | { readonly kind: 'too-large'; readonly bytes: number }
  | { readonly kind: 'cache-key-unstable' }

// ---------------------------------------------------------------------------
// 打开结果
// ---------------------------------------------------------------------------

export type OpenOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not-found' | 'no-application' | 'failed' }

/**
 * 在文件管理器中定位的结果。
 *
 * 与 {@link OpenOutcome} 分开，是因为 `no-application` 这一态在这里**不可能出现**：
 * 定位不涉及 MIME 关联。用一个更窄的类型，调用方就不需要处理不存在的分支。
 */
export type RevealOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'not-found' | 'failed' }

// ---------------------------------------------------------------------------
// 自定义应用图标
// ---------------------------------------------------------------------------

/**
 * 设置自定义图标失败的结构化原因。
 *
 * 文案只有一份，在 `shared/appicon.ts` —— 主进程要拿它填错误信息，界面要拿它填状态行
 * （与 `MigrationFailure` 同样的理由）。
 */
export type AppIconFailure =
  /** 选中的文件读不出来（权限、中途被删除）。 */
  | 'unreadable'
  /** 源文件超过上限。图标最终只有 512×512，读进来只是浪费内存。 */
  | 'too-large'
  /** 扩展名不在预期范围内。 */
  | 'unsupported-format'
  /** 扩展名对得上，但内容解不开（Chromium 的图片解码器认不出来）。 */
  | 'decode-failed'
  /** canvas 无法把裁剪结果编码成 PNG。 */
  | 'encode-failed'
  /** 回传的字节不是可解码的图片，或尺寸不合理。 */
  | 'invalid-image'
  /** 写图标文件或启动器条目失败（磁盘满、只读挂载、权限）。 */
  | 'write-failed'
  /** `~/.local/share/applications/` 下的同名条目不是本应用生成的。 */
  | 'desktop-entry-conflict'

/**
 * 自定义图标的当前状态。界面靠它渲染预览与按钮。
 *
 * `preview` 走数据 URL 而不是文件路径：界面层拿不到、也不该拿到文件系统里的路径
 * （`ai/INVARIANTS.md` G-1）。
 */
export interface AppIconState {
  /** 是否正在使用自定义图标。 */
  readonly custom: boolean
  /** 自定义图标的设置时间；未启用时为 null。 */
  readonly updatedAt: number | null
  /**
   * 用户级启动器条目是否已由本应用写入。
   *
   * **开发模式下恒为 false** —— 那时的 `Exec` 会指向 `node_modules` 里的 Electron，
   * 写进启动器只会变成一个点不开的图标（同 `integration/login.ts` 的判断）。
   */
  readonly desktopEntry: boolean
  /** 当前生效图标的 PNG 数据 URL；连默认图标都读不到时为 null。 */
  readonly preview: string | null
}

/**
 * 在系统对话框里挑一张图片的结果。
 *
 * `null`（由 `bridge.pickAppIcon` 返回）表示用户取消 —— 与失败分开，因为"取消"不是错误，
 * 不该在界面上留下任何痕迹。
 */
export type AppIconPickResult =
  | {
      readonly ok: true
      /** 原文件名，仅用于提示与日志（不参与任何路径拼接）。 */
      readonly name: string
      /**
       * 原文件字节。
       *
       * 传字节而不是传路径：路径是能力，字节只是数据。界面拿字节去解码、裁剪，
       * 落盘位置始终由主进程决定（`ai/INVARIANTS.md` G-1 / T2）。
       */
      readonly bytes: Uint8Array
    }
  | { readonly ok: false; readonly failure: AppIconFailure; readonly detail: string }

/** 设置或恢复图标的结果。 */
export type AppIconResult =
  | { readonly ok: true; readonly state: AppIconState }
  | { readonly ok: false; readonly failure: AppIconFailure; readonly detail: string }

/** 提交给主进程的裁剪结果，只含字节。 */
export interface AppIconInput {
  /** 已裁剪并缩放好的 PNG 字节，边长应当等于 `APP_ICON_SIZE`。 */
  readonly png: Uint8Array
}
