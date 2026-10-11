/**
 * 主进程与渲染进程共享的类型。
 *
 * 只放**数据形状**，不放实现。这里出现的类型不应该导入任何 Electron 类型 ——
 * 渲染进程也要能编译它。
 *
 * 唯一的例外是下面那个**默认值常量**（`./language` 的拼写词典）。它在这里被 import 而不是抄写，
 * 是因为"抄一遍"等于让两处说同一件事，改动时必然漏一处 —— 与 `constants.ts` 里删掉
 * 同值 `cacheBytes` 的那段说明是同一个理由。那个常量同样是纯数据。
 */

import { DEFAULT_SPELLCHECK_LANGUAGES } from './language'

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
  /**
   * 内容哈希 —— 这份内容的**身份**（[ADR-0031]）。
   *
   * 它不再是文件名：归档正文以原文名落盘（见 {@link storedName}）。同一份内容可能有
   * 多个名字（硬链接），但只有一个哈希。
   */
  readonly hash: string
  /** 打开时的原始文件名，用于展示与搜索。 */
  readonly name: string
  /**
   * 磁盘上的实际路径，**相对归档目录**：`<账号>/files/<年-月>/<原文名>`
   * （如 `18665597400/files/2026-10/合同.pdf`；同名冲突时文件名带一小段哈希后缀）。
   *
   * 打开与"在文件夹中显示"都用它定位文件。旧布局也都落在这一列里：`2026/10/…`
   * （[ADR-0037]）与平面布局（裸文件名，[ADR-0031] 到 [ADR-0037] 之间），更早的记录是内容
   * 哈希名 —— 因此这些形态都能打开（`archive/blobs.ts` 的 `archiveFilePath()`）。
   */
  readonly storedName: string
  readonly bytes: number
  readonly mime: string
  /** 归档时间（Unix 毫秒）。 */
  readonly openedAt: number

  /**
   * 会话的人类可读标签。
   *
   * 可选，且目前**总是**空的（`capture/download.ts` 那边解释了为什么）：要从页面取名字，
   * 而现在唯一读得到的会话字段是会话 JID（`msg.id.remote`，[ADR-0055]）—— 那是**标识**，
   * 不是给人看的标签。拿不到就是 `undefined`，不要为此引入新的数据源。
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
   * 空串表示"用默认位置"（`~/Documents/WaaChat_files`）—— 默认值刻意不写死成绝对
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
  /**
   * 是否启用内核自带的拼写检查（[ADR-0061]）。
   *
   * 关掉它是一个**真实的**选择，而不只是偏好：词典由内核按需从第三方下载（默认是 Google
   * 托管的 CDN），关掉之后那个请求不会发生。取舍见 `docs/security.md` 第 3 节。
   */
  readonly spellcheck: boolean
  /**
   * 拼写检查要查哪些语言，逗号分隔（判据表在 `shared/language.ts`）。
   *
   * 为什么用字符串而不是数组：Electron 自己的 `acceptLanguages` 就是这个形状，而"查哪些语言"
   * 是一组**顺序无关**的码 —— 一个形状表达两者，设置层便不必为"数组"这一种新类型单开一套
   * 逐字段校验（`settings.ts` 的 `coerce()` 只按 `typeof` 比对）。
   */
  readonly spellcheckLanguages: string
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
  spellcheck: true,
  spellcheckLanguages: DEFAULT_SPELLCHECK_LANGUAGES,
}

/**
 * 哪些设置**需要重启**才能生效。
 *
 * 界面对照这个列表渲染"重启后生效"的徽标与「立即重启」按钮，不自己写死。
 *
 * ⚠️ **现在是空的**：机制与按钮都留着 —— 它是有判据、有单测、有实测结论的一套东西
 * （[ADR-0064]），而"这一项要重启"是将来很容易再出现的性质。空列表的后果只有一个：
 * 那颗按钮不显示。
 *
 * 历史：最初只有 `enableCiphertextCache`（`ses.protocol.handle('https')` 过去只在启动时注册
 * 一次），密文缓存改事务式后出列（[ADR-0027]）；随后是 `uiLanguage`（[ADR-0063] 让它进来、
 * [ADR-0065] 把它挪去「重载即生效」、[ADR-0066] 把这一项整个撤掉）。它旁边那张
 * `RELOAD_REQUIRED_SETTINGS` 名单随 [ADR-0066] 一起删除 —— 那名单上从头到尾只有界面语言一项。
 */
export const RESTART_REQUIRED_SETTINGS: readonly SettingsKey[] = []

/** `Settings` 的键。跨 IPC 传"哪些设置项变了"时用它，而不是传裸字符串。 */
export type SettingsKey = keyof Settings

/**
 * 两个设置快照之间，**在「重启后生效」名单里、且真的变了**的那些键。
 *
 * 这是「立即重启」那颗按钮的唯一判据（[ADR-0064]），因此它必须是**纯函数**、能被单测：
 * 判错了的两个方向都很难看 —— 多显示一颗按钮是噪音，少显示一次会让用户以为
 * "改完就算生效了"，而那一项要等到他下次自己重启才生效。
 *
 * ⚠️ 比的是**值与键都相同**的项，因此"改过去又改回来"不算待办（与用户看到的界面一致：
 * 值回到原样，就没有任何东西等着生效）。
 */
export function changedRestartKeys(initial: Settings, current: Settings): SettingsKey[] {
  return RESTART_REQUIRED_SETTINGS.filter((key) => initial[key] !== current[key])
}

/**
 * 「有改动还没生效」的状态（读给界面看的，[ADR-0064]）。
 *
 * 它归**主进程**所有：只有它知道"进程启动时读到的设置是什么"（`main/settings.ts` 的快照）。
 * 让界面自己记一份也能算，但那就成了"界面维护我改过什么"——`shared/bridge.ts` 的 `setSettings`
 * 刻意返回完整设置，为的就是不出现这种两份状态互相打架的局面。
 */
export interface RestartState {
  /** 本次运行改过、且**要重启**才生效的键。空数组 = 没有待重启的改动。 */
  readonly restart: readonly SettingsKey[]
}

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
// 批量导出（[ADR-0050]）
// ---------------------------------------------------------------------------

/**
 * 单条导出失败的结构化原因。文案只有一份，在 `shared/export.ts`（与
 * {@link MigrationFailure} 同样的理由：主进程与界面各写一份，同一个失败会有两种措辞）。
 */
export type ArchiveExportFailure =
  /** 归档里已经没有这条记录的正文（被容量淘汰、或磁盘上的文件被手工删掉）。 */
  | 'missing'
  /** 目标目录里同名到挑不出可用名字（序号与哈希后缀全部被占）。 */
  | 'name-taken'
  /** 复制失败（权限、磁盘满、目标被挂载成只读）。 */
  | 'write-failed'

/**
 * 逐条失败。
 *
 * `name` 是**记录里的那个名字**（导出的目标名也从它来），界面要靠它说清"哪一个失败了"。
 * `null` 表示这条记录**本身**已经不在索引里了（在用户点"导出"与主进程读到它之间被淘汰）
 * —— 连名字都取不到，而"n 条记录已经不在归档里了"仍然要说出来。
 */
export interface ArchiveExportFailureItem {
  readonly name: string | null
  readonly reason: ArchiveExportFailure
}

/** 整次调用被拒绝的原因。这类失败**一个文件都没写**。 */
export type ArchiveExportRejection =
  /** 目标目录是归档目录本身、或落在它里面。 */
  | 'inside-archive'
  /** 选中的条数超过一次导出的上限。 */
  | 'too-many'
  /** 目标目录读不了（不存在、不是目录、不可写）。 */
  | 'target-unusable'

/**
 * 一次批量导出的结果。
 *
 * 三态（与 {@link ArchiveMigrationResult} 同构）：
 *   - `null`（不在这个类型里）：用户在选择目录时取消 —— 不是错误，界面不留任何痕迹；
 *   - `ok: false`：整次调用被拒绝，一个文件都没写；
 *   - `ok: true`：真的写了，可能**部分失败**（`failed` 逐条给出）。
 */
export type ArchiveExportResult =
  | {
      readonly ok: true
      /** 目标目录。要显示出来 —— 用户才知道文件去哪了。 */
      readonly dir: string
      readonly exported: number
      readonly failed: readonly ArchiveExportFailureItem[]
    }
  | { readonly ok: false; readonly reason: ArchiveExportRejection; readonly detail: string }

// ---------------------------------------------------------------------------
// 批量删除（[ADR-0053]）
// ---------------------------------------------------------------------------

/**
 * 单条删除失败的结构化原因。文案只有一份，在 `shared/deletion.ts`。
 *
 * 只有两种，因为"为什么没删掉"对用户只有两种可行动的区别：**它本来就不在了**（不用管），
 * 还是**删不动**（去看看磁盘/占用它的程序）。
 */
export type ArchiveDeleteFailure =
  /** 这条记录已经不在索引里了（在选中与确认之间被淘汰、或被另一次删除带走）。 */
  | 'missing'
  /**
   * 没能删掉：磁盘上的文件删不动（被占用、只读挂载、IO 错误），或索引记录没能删掉。
   *
   * ⚠️ 文件删不掉时**索引记录会保留**：两者必须一起走，否则会留下"搜得到但打不开"的
   * 悬空记录（[ADR-0048]）。因此这条失败意味着**这一条什么都没被改动**。
   */
  | 'remove-failed'

/** 逐条删除失败。`name` 为 `null` 表示这条记录本身已经取不到了（见 {@link ArchiveDeleteFailure}）。 */
export interface ArchiveDeleteFailureItem {
  readonly name: string | null
  readonly reason: ArchiveDeleteFailure
}

/** 整次调用被拒绝的原因。这类失败**一个文件都没删**。 */
export type ArchiveDeleteRejection =
  /** 选中的条数超过一次删除的上限。 */
  'too-many'

/**
 * 一次批量删除的结果。
 *
 * 三态（与 {@link ArchiveExportResult} 同构）：
 *   - `null`（不在这个类型里）：用户在确认框里点了"取消" —— 不是错误，界面不留任何痕迹；
 *   - `ok: false`：整次调用被拒绝，一个文件都没删；
 *   - `ok: true`：真的删了，可能**部分失败**（`failed` 逐条给出）。
 *
 * ⚠️ 删除**不可逆**，而且**按记录**进行：同一份内容被多条消息引用时（[ADR-0052] 的硬链接），
 * 删掉一条只少一个名字、**不会释放字节**，其余消息那一份照旧在。要腾空间请用「归档大小上限」
 * （[ADR-0048]）。
 */
export type ArchiveDeleteResult =
  | {
      readonly ok: true
      /** 真正删掉的**记录**条数。 */
      readonly deleted: number
      readonly failed: readonly ArchiveDeleteFailureItem[]
    }
  | { readonly ok: false; readonly reason: ArchiveDeleteRejection; readonly detail: string }

// ---------------------------------------------------------------------------
// 密文缓存的切换（静默转换，见 ADR-0027 / ADR-0028）
// ---------------------------------------------------------------------------

/**
 * 切换失败的结构化原因。文案在 `shared/cache-conversion.ts`。
 */
export type CacheSwitchFailure =
  /** 已经有一次切换在进行。切换本身是瞬时的，界面也会在期间禁用开关，这条是兜底。 */
  | 'busy'
  /** 读不了缓存目录（权限、被换成文件）。 */
  | 'unreadable'
  /** 搬条目或落设置时写盘失败（磁盘满、权限）。 */
  | 'write-failed'

/**
 * 一次切换的结果。
 *
 * `null`（不在这个类型里）表示这次调用什么都没做 —— 开关已经是目标状态，没有可转换的
 * 东西。它不是失败，界面按当前设置渲染即可。
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
