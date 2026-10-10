/**
 * IPC 通道注册。
 *
 * 这一层是**主进程唯一的对外（对界面）门面**。因此有两件事必须在这里做，
 * 而不是指望各业务模块自觉：
 *
 *  1. **校验调用方**。同一个 session 分区里同时跑着我们的界面窗口和远程页面，
 *     而远程页面是被承载的第三方内容。如果不校验来源，它就能调用这些通道。
 *     见 {@link guard}。
 *  2. **校验参数形状**。渲染进程的输入同样是输入，`id` 必须是整数。
 *
 * 通道名一律来自 `channels.ts`，本文件不出现字符串字面量。
 */

import { realpath } from 'node:fs/promises'
import { basename } from 'node:path'

import {
  app,
  dialog,
  ipcMain,
  session,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  type OpenDialogOptions,
} from 'electron'

import { ICON_DIALOG_EXTENSIONS } from '../../shared/appicon'
import type { ArchiveIdInput, ArchiveIdsInput } from '../../shared/bridge'
import { SESSION_PARTITION } from '../../shared/constants'
import { describeDeleteConfirmation } from '../../shared/deletion'
import { formatBytes } from '../../shared/format'
import { describeMigrationFailure } from '../../shared/migration'
import type {
  AppIconInput,
  AppIconPickResult,
  AppIconResult,
  ArchiveDeleteFailureItem,
  ArchiveDeleteResult,
  ArchiveExportResult,
  ArchiveQuery,
  ArchiveRecord,
  CacheSwitchFailure,
  CacheSwitchResult,
  Settings,
} from '../../shared/types'
import { removeStoredFile } from '../archive/blobs'
import { DELETE_MAX_ITEMS, deleteRecords } from '../archive/delete'
import { EXPORT_MAX_ITEMS, exportRecords, isInsideArchive } from '../archive/export'
import { planMigration } from '../archive/migrate'
import { relocateArchive } from '../archive/relocate'
import { archiveStore, enforceArchiveLimit } from '../archive/store'
import { cacheUsage, enforceCacheLimit, planCacheConversion } from '../capture/cache-files'
import { switchCiphertextCache } from '../capture/cache-switch'
import {
  appIconState,
  effectiveAppIcon,
  readIconSource,
  resetAppIcon,
  setAppIcon,
} from '../integration/appicon'
import { applyLaunchAtLogin } from '../integration/login'
import { openPath, revealPath } from '../integration/open'
import { getTray } from '../integration/tray'
import { logger } from '../logger'
import { archiveDir } from '../paths'
import { getSettings, updateSettings } from '../settings'
import { getFilesWindow, getSettingsWindow } from '../window'
import { CHANNELS } from './channels'

/**
 * 调用方是否可信。
 *
 * 判据是"这一帧的 URL 是不是我们自己加载的东西"，分三种：
 *
 *   - `file://`                  → 打包后的界面（`loadFile`）
 *   - `ELECTRON_RENDERER_URL`    → 开发模式的 Vite 服务器
 *   - 其它（含 `https://…`）      → 拒绝
 *
 * 额外要求是**主帧**：子帧（比如嵌入的 iframe）没有理由调用本地能力。
 *
 * ⚠️ 这里不能写成"拒绝看起来像上游的 URL"（黑名单）。上游换域名的那一天，
 * 黑名单会静默失效；白名单只是变成"拒绝一切"，用户立刻会发现。
 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (frame === null) return false
  if (frame.parent !== null) return false

  const url = frame.url
  if (url.startsWith('file://')) return true

  const devServer = process.env['ELECTRON_RENDERER_URL']
  return app.isPackaged === false && devServer !== undefined && url.startsWith(devServer)
}

/**
 * 注册一个通道，并在真正调用处理函数之前做完校验。
 *
 * 被拒绝时**抛错**而不是返回 `null`：静默返回会把"越权调用"伪装成"没有数据"，
 * 排查时会往数据方向找一整天。
 */
function guard<Args extends unknown[], Result>(
  channel: string,
  handler: (...args: Args) => Result | Promise<Result>,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      logger.warn('ipc: rejected call from untrusted sender', { channel })
      throw new Error(`ipc: untrusted sender for ${channel}`)
    }
    return handler(...(args as Args))
  })
}

/** `id` 必须是正整数。来自渲染进程的一切都要当成不可信输入。 */
function toId(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null
  const id = (value as Partial<ArchiveIdInput>).id
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null
}

/**
 * 一串 `id`：每个都必须是正整数。批量操作的入参。
 *
 * 两个额外的收紧，都是"界面不该送、但送了也不能信"：
 *
 *   - **去重**：重复的 id 会让同一条记录被处理两次，第二次必然落在"记录已经不在"上 ——
 *     结果行里就多出一条莫名其妙的失败；
 *   - **逐项校验类型**，而不是只判 `Array.isArray`：含 `'x'` 的数组若被放过，会一路走到
 *     `WHERE id = ?` 才炸，那时错误信息已经指不回入参了。长度上限不在这里判（那是业务规则，
 *     由调用方译成 `too-many`），因此入参形状必须**先**干净。
 */
function toIds(value: unknown): number[] | null {
  if (typeof value !== 'object' || value === null) return null

  const ids = (value as Partial<ArchiveIdsInput>).ids
  if (!Array.isArray(ids)) return null

  const unique = new Set<number>()
  for (const id of ids) {
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return null
    unique.add(id)
  }

  return [...unique]
}

/**
 * 把一串 id 解析成记录（批量导出与批量删除共用的第一步）。
 *
 * 取不到的 id **不抛错**：它们译成逐条失败 `missing`，与"逐条处理失败"走同一条路 ——
 * 用户是按自己选了几条来对账的，静默少一条会让"3 个成功"变成谎话（`ai/CONVENTIONS.md`
 * 第 4 节）。这条路径是真实可达的：选中与点击之间可能刚好有一次容量淘汰（[ADR-0048]）。
 *
 * `missingReason` 由调用方给：导出与删除各有自己的失败原因类型，但"这条记录已经不在"这一点
 * 两边的名字相同（`'missing'`），因此这里只负责配对。
 */
function resolveRecords<Reason extends string>(
  ids: readonly number[],
  missingReason: Reason,
): {
  readonly found: readonly ArchiveRecord[]
  readonly failed: readonly { readonly name: null; readonly reason: Reason }[]
} {
  const store = archiveStore()
  const found: ArchiveRecord[] = []
  let missing = 0

  for (const id of ids) {
    const record = store.byId(id)
    if (record === null) {
      missing += 1
      continue
    }
    found.push(record)
  }

  return {
    found,
    failed: Array.from({ length: missing }, () => ({ name: null, reason: missingReason })),
  }
}

function toQuery(value: unknown): ArchiveQuery {
  if (typeof value !== 'object' || value === null) return {}

  const input = value as Record<string, unknown>
  const query: {
    text?: string
    limit?: number
    offset?: number
  } = {}

  if (typeof input['text'] === 'string') query.text = input['text']
  if (typeof input['limit'] === 'number' && Number.isInteger(input['limit']))
    query.limit = input['limit']
  if (typeof input['offset'] === 'number' && Number.isInteger(input['offset']))
    query.offset = input['offset']

  return query
}

/**
 * 交给界面的设置。
 *
 * `archiveDir` 在配置文件里可以是空串（"用默认位置"），但界面需要显示**实际生效**的
 * 目录 —— 否则那一行会是空白，用户无从知道文件到底存到了哪。
 */
function presentSettings(settings: Settings): Settings {
  return { ...settings, archiveDir: archiveDir() }
}

/**
 * 部分更新设置。
 *
 * 只接受 `Settings` 里已存在的键，值由 `settings.ts` 的 `coerce` 逐字段校验类型 ——
 * 因此渲染进程传一个 `{"evil": true}` 不会污染配置文件（未知键会被丢弃）。
 */
/**
 * 密文缓存的切换正在跑（[ADR-0027]）。
 *
 * 它只守**这一条通道**：界面会在转换期间禁用那个开关，因此正常路径下没人能再发起一次；
 * 这个标志是兜底，挡住"界面还没来得及重画、用户已经点到了"这类窗口，以及将来可能出现的
 * 别的调用方。它**不**冻结其它设置 —— 转换在后台进行，没有理由连带挡住别的开关
 * （`updateSettings` 本身是同步落盘的，不存在交叉写入）。
 */
let cacheSwitchInProgress = false

function applySettings(value: unknown): Settings {
  if (typeof value !== 'object' || value === null) return presentSettings(getSettings())

  const patch = value as Partial<Settings>

  /**
   * 换保存位置**不**走设置通道：它必须伴随数据迁移（见 `archive/relocate.ts`），
   * 那条路有自己的对话框、进度与回滚。允许从这里改它，只会得到一个"设置指向新目录、
   * 数据还留在旧目录"的半截状态，而且要到下次重启才显形。
   *
   * 这里**抛错而不是静默忽略**：静默会让调用方以为改动生效了（见 ai/CONVENTIONS.md 第 4 节）。
   */
  if ('archiveDir' in patch) {
    throw new Error(`ipc: ${CHANNELS.archiveDirPick} is the only way to change archiveDir`)
  }

  /**
   * 密文缓存的开关同理：它必须伴随一次真实的文件转换与协议层的挂/摘（[ADR-0027]）。
   * 从这里直接改它的后果不是"半截状态"，而是"设置说关闭、磁盘上却还留着缓存" ——
   * 也就是"状态不一致"本身。界面侧也不走这条路，两边都拦。
   */
  if ('enableCiphertextCache' in patch) {
    throw new Error(`ipc: ${CHANNELS.cacheSwitch} is the only way to change the ciphertext cache`)
  }

  const next = updateSettings(patch)

  // 自启是"设置 → 系统"的副作用，必须在这里落地，否则用户会以为开关坏了。
  if ('launchAtLogin' in patch) applyLaunchAtLogin(next.launchAtLogin)

  /**
   * 改小了归档上限就**立刻**按新值淘汰一次（[ADR-0048]）：不这么做的话，占用会一直停在
   * 旧值上直到下一次下载 —— 用户刚把上限调到 1 GB、界面却还说占了 5 GB，那是"设置没生效"
   * 的观感。调大或改成"不限制"时这次淘汰是空操作（`enforceLimit()` 自己判）。
   */
  if ('archiveMaxBytes' in patch) enforceArchiveLimit(next.archiveMaxBytes)

  /**
   * 密文缓存那一边同理（[ADR-0049]）：调小上限就**立刻**回收一次。它是异步的（全盘扫描，
   * 不能让界面等），因此这里只发起、不等待 —— `enforceCacheLimit()` 自己永不抛错。
   */
  if ('cacheMaxBytes' in patch) void enforceCacheLimit(next.cacheMaxBytes)

  logger.info('settings updated', { keys: Object.keys(patch).join(',') })
  return presentSettings(next)
}

/**
 * 系统对话框统一挂在我们自己的窗口上（有窗口时是模态的）。
 *
 * 挂窗口不是装饰：迁移确认框必须挡在设置界面前面，否则用户可以在"确认迁移"的同时
 * 继续点「更改…」，两个迁移互相踩同一个目录。没有窗口时（理论上不会发生）退化为
 * 无父窗口的对话框，而不是放弃这一步。
 *
 * ⚠️ 父窗口由**发起方**决定，而不是这里"随便找一扇本地窗口"——那正是拆分窗口（[ADR-0025]）
 * 要消灭的猜测，猜错的症状是对话框跑到另一扇窗口后面，用户以为按钮没反应：
 *
 *   - 设置项发起的（迁移确认、选择保存位置、选择图标）→ **设置窗口**；
 *   - 文件列表发起的（导出到哪个目录、确认删除）→ **文件列表窗口**（[ADR-0050] / [ADR-0053]）。
 */
async function showBox(
  options: MessageBoxOptions,
  owner: BrowserWindow | null,
): Promise<MessageBoxReturnValue> {
  return owner === null || owner.isDestroyed()
    ? await dialog.showMessageBox(options)
    : await dialog.showMessageBox(owner, options)
}

/** 一次目录选择要问用户的全部东西。`owner` 见 {@link showBox} 的说明。 */
interface DirectoryRequest {
  readonly title: string
  readonly buttonLabel: string
  readonly defaultPath: string
  readonly owner: BrowserWindow | null
}

/** 让用户挑一个目录。取消时返回 `null`。 */
async function chooseDirectory(request: DirectoryRequest): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: request.title,
    buttonLabel: request.buttonLabel,
    // createDirectory 让用户在对话框里就能建一个新目录（默认位置就是这么来的）。
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: request.defaultPath,
  }

  const owner = request.owner
  const result =
    owner === null || owner.isDestroyed()
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(owner, options)

  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

/**
 * 导出对话框的默认目录：系统的「下载」目录。
 *
 * **不能**默认到归档目录 —— 那正好会被 `isInsideArchive()` 拒绝，用户一进去就要吃一次错。
 *
 * 精简的 Linux 环境（容器、部分最小桌面）没有配全 XDG 用户目录，此时 `getPath('downloads')`
 * 会**抛错**；退到「家」目录，而不是让整次调用失败 —— 默认值只是方便，不是前置条件。
 */
function defaultExportDir(): string {
  try {
    return app.getPath('downloads')
  } catch {
    return app.getPath('home')
  }
}

/**
 * 让用户挑一张图片，返回它的**字节**。取消时返回 `null`。
 *
 * 不给"所有文件"这一项：能解码的格式已经列全，放开只会让用户选中一个必然失败的文件，
 * 然后收到一句"不支持的格式"（而那个文件本来就看不出哪里不对）。
 *
 * 父窗口见 {@link showBox} 的说明。
 */
async function chooseIconFile(): Promise<AppIconPickResult | null> {
  const options: OpenDialogOptions = {
    title: '选择要作为应用图标的图片',
    buttonLabel: '使用这张图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: [...ICON_DIALOG_EXTENSIONS] }],
  }

  const window = getSettingsWindow()
  const result =
    window === null || window.isDestroyed()
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options)

  if (result.canceled || result.filePaths.length === 0) return null

  const path = result.filePaths[0]
  // 只把 basename 往下传：完整路径在这里之后就没有第二个用途了（G-1）。
  return readIconSource(path, basename(path))
}

/**
 * 把渲染进程送来的图标数据收成字节。
 *
 * 结构化克隆会把 `Uint8Array` 原样送达，但**不要**因此相信它 —— 类型可能被改成字符串，
 * 也可能塞一个超大数组进来。除了"是不是字节"以外的判断都在 `appicon.ts` 里做。
 */
function toIconBytes(value: unknown): Uint8Array | null {
  if (typeof value !== 'object' || value === null) return null
  const png = (value as Partial<AppIconInput>).png
  return png instanceof Uint8Array ? png : null
}

/**
 * 图标换了之后，把托盘那一份也刷新掉。
 *
 * 托盘**不归** `appicon.ts` 管（那会引入 window → appicon → tray → window 的循环依赖），
 * 所以这最后一步留在这里。漏掉它的症状很具体：窗口换了新图标，托盘还是旧的。
 *
 * ⚠️ **不要**把这里改成"销毁旧托盘再建一个新的"。社区里流传的说法是 appindicator 下
 * `setImage()` 不生效、必须重建托盘 —— 但重建正是产生 GLib
 * `instance … has no handler with id …` 这类 **stale handler** 警告的经典模式（[ADR-0034]），
 * 而我们无法在本机验证那条生命周期（没有指示器宿主）。代价是：部分指示器实现下托盘图标
 * 要下次启动才更新，这一点写在 `docs/usage.md` 的「应用图标」一节里。
 */
function refreshTrayIcon(result: AppIconResult): AppIconResult {
  if (!result.ok) return result

  const image = effectiveAppIcon()
  if (image !== null) getTray()?.setImage(image)

  return result
}

export function registerIpcHandlers(): void {
  /**
   * 归档存储**每次**向 `archiveStore()` 取，而不是在这里捕获一份引用：用户在设置里
   * 换了文件保存位置时索引连接会被重开（`applyArchiveDir`），缓存下来的那份引用
   * 仍然指着旧数据库 —— 症状是"换了目录之后归档界面查的还是旧索引"。
   */

  // --- 归档 -----------------------------------------------------------------

  guard(CHANNELS.archiveList, (query: unknown) => archiveStore().list(toQuery(query)))

  guard(CHANNELS.archiveGet, (input: unknown) => {
    const id = toId(input)
    return id === null ? null : archiveStore().byId(id)
  })

  guard(CHANNELS.archiveOpen, async (input: unknown) => {
    const id = toId(input)
    if (id === null) return { ok: false, reason: 'not-found' } as const

    const record = archiveStore().byId(id)
    if (record === null) return { ok: false, reason: 'not-found' } as const

    // 定位文件靠 storedName（磁盘上的实际路径：`<账号>/files/<年-月>/<原名>`），
    // 哈希只用于日志与失败报告（ADR-0031 / ADR-0039）。
    return openPath(record.hash, record.storedName)
  })

  guard(CHANNELS.archiveReveal, (input: unknown) => {
    const id = toId(input)
    if (id === null) return { ok: false, reason: 'not-found' } as const

    const record = archiveStore().byId(id)
    if (record === null) return { ok: false, reason: 'not-found' } as const

    return revealPath(record.hash, record.storedName)
  })

  guard(CHANNELS.archiveStats, async () => {
    /**
     * 两份统计在**这一层**组合（[ADR-0049]）：`archive/` 不得 import `capture/`
     * （`ai/CONVENTIONS.md` 第 2 节的方向），因此缓存占用由这里补进 `cacheBytes` ——
     * 在此之前它一直是写死的 0，界面上那个数字从来不存在。
     */
    const stats = archiveStore().stats()
    const cache = await cacheUsage()

    return { ...stats, cacheBytes: cache.bytes }
  })

  /**
   * 批量导出（[ADR-0050]）。
   *
   * 与迁移的流程差别是根本性的：导出**没有回滚**（它只往用户的目录里写副本，归档那边一个
   * 字节都不动），因此这里不需要"先算计划"那一步，只有"拿目录 → 逐条复制 → 报告"。
   *
   * ⚠️ `realpath` 必须在 `isInsideArchive()` **之前**做：纯字符串比较挡不住一条指向归档内部的
   * 符号链接（`export.ts` 的注释写着这条前提，由调用方负责）。目标目录是用户刚在对话框里选的，
   * 因此正常情况 `realpath` 必然成功 —— 失败就是"这个目录用不了"，不是异常。
   */
  guard(CHANNELS.archiveExport, async (input: unknown): Promise<ArchiveExportResult | null> => {
    const ids = toIds(input)
    if (ids === null || ids.length === 0) return null

    if (ids.length > EXPORT_MAX_ITEMS) {
      return { ok: false, reason: 'too-many', detail: String(EXPORT_MAX_ITEMS) }
    }

    const { found, failed } = resolveRecords(ids, 'missing')

    const chosen = await chooseDirectory({
      title: '选择导出到哪个目录',
      buttonLabel: '导出到此处',
      defaultPath: defaultExportDir(),
      // 导出由文件列表发起（[ADR-0050] 决定 4）。
      owner: getFilesWindow(),
    })

    // 取消不是错误：界面不留任何痕迹，归档一个字节都没动。
    if (chosen === null) return null

    try {
      const target = await realpath(chosen)
      if (isInsideArchive(target, await realpath(archiveDir()))) {
        return { ok: false, reason: 'inside-archive', detail: target }
      }

      const summary = await exportRecords(found, target)

      return {
        ok: true,
        dir: target,
        exported: summary.exported,
        failed: [...failed, ...summary.failed],
      }
    } catch (error) {
      /**
       * `exportRecords()` 只在目标目录读不了时抛错（它开头是一个 `readdir`）。那一刻**一个文件
       * 都还没写**，因此这是"整次调用被拒绝"，与"写了一半、有几条失败"不是一回事。
       */
      logger.warn('archive: export rejected', { reason: (error as Error).name })
      return { ok: false, reason: 'target-unusable', detail: chosen }
    }
  })

  /**
   * 批量删除（[ADR-0053]）。
   *
   * 流程：解析记录 → **确认** → 逐条"先删文件、成功了才删索引记录"。
   *
   * 确认框不是装饰：这一步**不可逆**（磁盘上的明文也一起删掉）。因此默认按钮落在"取消"上，
   * 与迁移确认框同一条理由 —— 一次回车不该毁掉用户选中的东西。
   *
   * 全部选中的记录都已经不在时（两次点击之间被淘汰），**不弹框**：没有任何东西可以删，
   * 弹一个"删除 0 个文件？"只会让人困惑。结果照常逐条报 `missing`。
   */
  guard(CHANNELS.archiveDelete, async (input: unknown): Promise<ArchiveDeleteResult | null> => {
    const ids = toIds(input)
    if (ids === null || ids.length === 0) return null

    if (ids.length > DELETE_MAX_ITEMS) {
      return { ok: false, reason: 'too-many', detail: String(DELETE_MAX_ITEMS) }
    }

    const { found, failed } = resolveRecords(ids, 'missing')
    const missing: ArchiveDeleteFailureItem[] = [...failed]

    if (found.length === 0) return { ok: true, deleted: 0, failed: missing }

    const confirmed = await showBox(
      {
        type: 'warning',
        title: '从归档里删除',
        message: `删除选中的 ${found.length} 个文件？`,
        detail: describeDeleteConfirmation(
          found.length,
          formatBytes(found.reduce((total, record) => total + record.bytes, 0)),
        ),
        buttons: ['删除', '取消'],
        // 默认落在"取消"上：删除不可逆，不该被一次回车误触发。
        defaultId: 1,
        cancelId: 1,
      },
      getFilesWindow(),
    )

    // 取消不是错误：返回 null，界面保持原样，一条记录都没动。
    if (confirmed.response !== 0) return null

    const store = archiveStore()
    const summary = deleteRecords(found, removeStoredFile, (id) => store.deleteById(id))

    return { ok: true, deleted: summary.deleted, failed: [...missing, ...summary.failed] }
  })

  // --- 设置 -----------------------------------------------------------------

  guard(CHANNELS.settingsGet, () => presentSettings(getSettings()))
  guard(CHANNELS.settingsSet, (patch: unknown) => applySettings(patch))

  guard(CHANNELS.archiveDirPick, async () => {
    const chosen = await chooseDirectory({
      title: '选择文件的保存位置',
      buttonLabel: '选择此目录',
      defaultPath: archiveDir(),
      owner: getSettingsWindow(),
    })
    if (chosen === null) return null

    /**
     * 先算计划、再做任何改动：目标能不能用、有多少东西要搬，都必须在用户点"确认"
     * 之前确定 —— 确认框要写清楚"把 N 个文件（X）搬到哪里"，而不是先让他确认、
     * 再告诉他"这个目录不行"。
     */
    const planned = planMigration(archiveDir(), chosen)
    if (!planned.ok) {
      await showBox(
        {
          type: 'error',
          title: '无法迁移归档',
          message: describeMigrationFailure(planned.failure, planned.detail),
          buttons: ['知道了'],
        },
        getSettingsWindow(),
      )
      return null
    }

    const { plan } = planned
    const confirmed = await showBox(
      {
        type: 'question',
        title: '迁移归档文件',
        message: '把归档迁移到新位置？',
        detail: [
          `从：${plan.source}`,
          `到：${plan.target}`,
          '',
          `共 ${plan.summary.files} 个文件，${formatBytes(plan.summary.bytes)}。`,
          '迁移完成后原位置不再保留归档，迁移期间请不要退出应用。',
          '归档是解密后的明文，请不要把新位置放在云同步盘里。',
        ].join('\n'),
        buttons: ['迁移', '取消'],
        // 默认落在"取消"上：这是一次真实的文件搬动，不该被一次回车误触发。
        defaultId: 1,
        cancelId: 1,
      },
      getSettingsWindow(),
    )

    // 取消不是错误：返回 null，界面保持原样，存储位置一点都不变。
    if (confirmed.response !== 0) return null

    const outcome = await relocateArchive(
      plan,
      (progress) => {
        // 进度只推给设置窗口：进度行长在设置页里（ADR-0025），别的窗口没有它的宿主。
        const window = getSettingsWindow()
        if (window === null || window.isDestroyed()) return
        window.webContents.send(CHANNELS.archiveMigration, progress)
      },
      () => {
        // 只写盘、不切目录：切目录由 relocateArchive 在所有步骤都成功之后自己做。
        updateSettings({ archiveDir: plan.target })
      },
    )

    if (!outcome.ok) return outcome

    return {
      ok: true,
      target: outcome.target,
      migrated: outcome.migrated,
      settings: presentSettings(getSettings()),
    }
  })

  /**
   * 切换密文磁盘缓存（[ADR-0027] / [ADR-0028]）。
   *
   * 流程全在主进程：算规模 → 转换 → 提交，**没有确认框也没有进度推送** —— 界面只是发起
   * 一次调用、等它返回。这样"界面以为成功了、主进程其实没提交"不可能发生。
   *
   * 参数只有一个布尔值：这一层没有可被滥用的路径或标识，它只会清掉**我们自己的**缓存目录
   * 里的派生数据，并且必须伴随一次真实转换（`settings:set` 改不动它）。
   */
  guard(CHANNELS.cacheSwitch, async (input: unknown): Promise<CacheSwitchResult | null> => {
    // 来自渲染进程的一切都当成不可信输入。
    if (typeof input !== 'boolean') return null

    const failed = (
      failure: CacheSwitchFailure,
      detail: string,
      rolledBack: boolean,
    ): CacheSwitchResult => ({
      ok: false,
      failure,
      detail,
      rolledBack,
      settings: presentSettings(getSettings()),
    })

    // 已经是目标状态：不动文件。界面按设置渲染开关，正常不会走到这里。
    if (input === getSettings().enableCiphertextCache) return null

    if (cacheSwitchInProgress) return failed('busy', '', true)

    /**
     * 先算规模、再动手。读不到目录时**不开始转换** —— 报告成一次普通的失败，由开关那一行
     * 说明（这里曾经弹一个错误框；确认框去掉之后，它跟着回到与其它失败同一条路上）。
     */
    const planned = planCacheConversion(input)
    if (!planned.ok) return failed('unreadable', planned.detail, true)

    cacheSwitchInProgress = true

    try {
      const outcome = await switchCiphertextCache(
        planned.plan,
        session.fromPartition(SESSION_PARTITION),
        getSettings,
        () => {
          updateSettings({ enableCiphertextCache: input })
        },
      )

      const settings = presentSettings(getSettings())

      return outcome.ok
        ? {
            ok: true,
            enabled: outcome.enabled,
            settings,
            converted: outcome.converted,
            bytes: outcome.bytes,
            pendingCleanup: outcome.pendingCleanup,
          }
        : {
            ok: false,
            failure: outcome.failure,
            detail: outcome.detail,
            rolledBack: outcome.rolledBack,
            settings,
          }
    } finally {
      cacheSwitchInProgress = false
    }
  })

  // --- 应用图标 --------------------------------------------------------------

  guard(CHANNELS.appIconGet, () => appIconState())

  guard(CHANNELS.appIconPick, () => chooseIconFile())

  guard(CHANNELS.appIconSet, (input: unknown) => {
    const png = toIconBytes(input)
    if (png === null) {
      const invalid: AppIconResult = {
        ok: false,
        failure: 'invalid-image',
        detail: '没有收到图片数据',
      }
      return invalid
    }

    return refreshTrayIcon(setAppIcon(png))
  })

  guard(CHANNELS.appIconReset, () => refreshTrayIcon(resetAppIcon()))

  logger.info('ipc: handlers registered')
}
