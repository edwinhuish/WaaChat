/**
 * 文件列表窗口的主体（前身是「归档」标签页，见 ADR-0025）。
 *
 * 这是整个应用的使用面：文件被接管后落进**归档**（数据层的概念，见 ADR-0018），
 * 用户在这扇窗口里找它、打开它、在文件管理器里定位它、把它导出去、或者删掉。
 *
 * 三处容易写错、且症状很难归因的地方：
 *
 *   1. **搜索的竞态**。用户在搜索框里快速输入时会发出多个请求，而它们不保证按顺序返回。
 *      不做处理的话，先发的慢请求会覆盖后发的快请求，用户看到的结果与输入框里的字**对不上**。
 *      下面的 `requestId` 就是为此存在。
 *   2. **选中集是"记录的 id"，不是"哪几个复选框"**。列表每次刷新都会把行整个重建一遍，
 *      闭包里的 DOM 引用随即失效；而"这条记录被选中了"才是刷新前后同一个语义
 *      （[ADR-0050] 的已知限制：选择集按可见性收敛）。
 *   3. **结果行与统计行必须分开写**（[ADR-0050] 决定 9）。曾经共用一个元素：结果刚写完就被
 *      紧随其后的 `refresh()` 用统计覆盖，于是"打开失败"这类提示只存在几毫秒、事实上从没
 *      被人看见过 —— 那直接违反 `ai/CONVENTIONS.md` 第 4 节。
 */

import { actionButtonAttrs } from '../../shared/action-button'
import { describeDeleteRejection, describeDeleteResult } from '../../shared/deletion'
import { describeExportRejection, describeExportResult } from '../../shared/export'
import type { ArchiveRecord, OpenOutcome, RevealOutcome } from '../../shared/types'
import { formatBytes, formatTimestamp } from '../../shared/format'
import { bridge } from '../bridge'
import { clear, h } from '../dom'

/** 一次取多少条。界面是列表而不是分页器，够用即可。 */
const PAGE_SIZE = 100

/** 搜索防抖。太短会在快速输入时打出无意义的请求，太长会让人觉得卡。 */
const SEARCH_DEBOUNCE_MS = 180

/**
 * 文件列表窗口里脚本要碰的全部节点。
 *
 * 收成一个对象而不是七个位置参数：这个签名已经长到"多传一个少传一个都要数一遍"的程度，
 * 而传错位置的两个 `HTMLElement` 在类型上完全相同 —— 编译期一点忙都帮不上。
 */
export interface ArchiveParts {
  readonly list: HTMLElement
  /** 统计行（个数 / 占用 / 缓存）。 */
  readonly footer: HTMLElement
  /** 结果行。与 `footer` 分开，见文件头第 3 点。 */
  readonly status: HTMLElement
  readonly search: HTMLInputElement
  readonly refreshButton: HTMLButtonElement
  readonly selectAll: HTMLInputElement
  readonly selection: HTMLElement
  readonly exportButton: HTMLButtonElement
  readonly deleteButton: HTMLButtonElement
}

export interface ArchiveView {
  refresh(): Promise<void>
}

/**
 * 一次批量动作的结果。
 *
 * `cancelled` 单独占一态而不是用 `null` 表示：**取消**与"做完了但没有话要说"必须区分开 ——
 * 用户取消了目录对话框，我们不该把他刚选的十几项清空。
 */
type BatchOutcome =
  { readonly cancelled: true } | { readonly cancelled: false; readonly message: string }

export function mountArchiveView(parts: ArchiveParts): ArchiveView {
  const {
    list,
    footer,
    status,
    search,
    refreshButton,
    selectAll,
    selection,
    exportButton,
    deleteButton,
  } = parts

  let requestId = 0
  let debounce: ReturnType<typeof setTimeout> | undefined

  /** 当前**可见**的记录（刚刚渲染出去的那一批）。"全选"与收敛都以它为准。 */
  let visible: readonly ArchiveRecord[] = []

  /** 已选中的记录 id。见文件头第 2 点。 */
  const selected = new Set<number>()

  /**
   * 结果行。空串即隐藏 —— 留下一个空元素会让页脚与列表之间多出一段说不清的空白。
   */
  function setStatus(text: string): void {
    status.textContent = text
    status.hidden = text === ''
  }

  async function refresh(): Promise<void> {
    const current = ++requestId

    try {
      const records = await bridge().listArchive({ text: search.value, limit: PAGE_SIZE })
      if (current !== requestId) return // 有更新的请求在路上，丢弃本次结果。

      render(records)
      await renderFooter(records, footer)
    } catch (error) {
      if (current !== requestId) return
      visible = []
      clear(list)
      list.append(
        h('li', {}, h('div', { class: 'empty', text: `读取归档失败：${asMessage(error)}` })),
      )
      renderSelection()
    }
  }

  function render(records: readonly ArchiveRecord[]): void {
    visible = records
    pruneSelection()

    clear(list)

    if (records.length === 0) {
      list.append(
        h(
          'li',
          {},
          h('div', {
            class: 'empty',
            text:
              search.value.trim() === ''
                ? '归档还是空的。在聊天里点一个文件，它会出现在这里。'
                : '没有匹配的文件。',
          }),
        ),
      )
      renderSelection()
      return
    }

    for (const record of records) {
      list.append(archiveRow(record))
    }

    renderSelection()
  }

  /**
   * 丢掉不再可见的选中项（[ADR-0050] 的已知限制）。
   *
   * 不收敛的后果很具体：用户搜了两次、各选了几项，然后按下「导出…」—— 导出的条数与他此刻
   * 在屏幕上数出来的不一致，而"我明明选了三项"没有任何办法自证。
   */
  function pruneSelection(): void {
    const visibleIds = new Set(visible.map((record) => record.id))
    for (const id of [...selected]) {
      if (!visibleIds.has(id)) selected.delete(id)
    }
  }

  /**
   * 让"选中集"在界面上显形：已选条数、两个批量按钮的可用性、全选框的三种状态。
   *
   * 只有这一处根据 `selected` 改界面 —— 按钮的 disabled 状态由它独占，因此在别处
   * "无条件恢复可用"会让"选中的都被删掉了"之后按钮仍然可点。
   */
  function renderSelection(): void {
    const count = selected.size

    selection.textContent = count === 0 ? '' : `已选 ${count} 项`
    exportButton.disabled = count === 0
    deleteButton.disabled = count === 0

    selectAll.disabled = visible.length === 0
    selectAll.checked = visible.length > 0 && count === visible.length
    // 部分选中：原生复选框有第三种形态，不给它会让"全选"看起来是没选。
    selectAll.indeterminate = count > 0 && count < visible.length
  }

  /**
   * 一行归档记录。
   *
   * 注意文件名走 `textContent`（`h()` 的 `text` 属性）而不是 `innerHTML`：
   * 这个字符串来自对端发送者，拼进标记里就是我们自己造的注入点。
   */
  function archiveRow(record: ArchiveRecord): HTMLLIElement {
    const pick = h('input', {
      class: 'pick',
      type: 'checkbox',
      dataRole: 'archive-pick',
      title: '选中这个文件',
      checked: selected.has(record.id),
      onChange: () => {
        if (pick.checked) selected.add(record.id)
        else selected.delete(record.id)

        renderSelection()
      },
    })

    const openButton = h('button', {
      ...actionButtonAttrs('打开'),
      onClick: () =>
        void runAction(openButton, () => bridge().openArchive({ id: record.id }), describeOpen),
    })

    const revealButton = h('button', {
      ...actionButtonAttrs('在文件夹中显示'),
      onClick: () =>
        void runAction(
          revealButton,
          () => bridge().revealArchive({ id: record.id }),
          describeReveal,
        ),
    })

    const sub = [formatBytes(record.bytes), formatTimestamp(record.openedAt)]
    if (record.mime !== '') sub.push(record.mime)
    if (record.chatLabel !== undefined) sub.push(record.chatLabel)

    return h(
      'li',
      {},
      pick,
      h(
        'div',
        { class: 'meta' },
        h('span', { class: 'name', text: record.name, title: record.name }),
        h('span', { class: 'sub', text: sub.join(' · ') }),
      ),
      openButton,
      revealButton,
    )
  }

  /**
   * 跑一个动作并把结果反馈到结果行。
   *
   * 失败**必须**说出来：这一层的失败模式（归档被清理、系统没有关联应用）都会让用户
   * 以为是自己的操作错了。静默失败是 `ai/CONVENTIONS.md` 第 4 节明确禁止的。
   */
  async function runAction<T extends OpenOutcome | RevealOutcome>(
    button: HTMLButtonElement,
    action: () => Promise<T>,
    describe: (outcome: T) => string | null,
  ): Promise<void> {
    setStatus('')
    button.disabled = true
    try {
      const outcome = await action()
      const message = describe(outcome)
      if (message !== null) setStatus(message)
      // 打开过的文件其"打开时间"会更新（索引里是 upsert），因此刷新一次列表。
      await refresh()
    } catch (error) {
      setStatus(`操作失败：${asMessage(error)}`)
    } finally {
      button.disabled = false
    }
  }

  /**
   * 跑一次批量动作（导出 / 删除）。
   *
   * 与 {@link runAction} 的两处不同，都是"一批"带来的：
   *
   *   - 参数是**当前选中集的快照**（`[...selected]`）。动作跑完之前用户还能点别的复选框，
   *     那时再读一次 `selected` 会得到"我按了按钮之后又改过"的集合 —— 而用户按下按钮那一刻
   *     看到的就是他确认的东西。
   *   - 结束后**清空选择**：残留的选中项会让下一次点击对"上一步选的东西"再作用一次
   *     （删除尤其不可接受）。取消时**不清**，见 {@link BatchOutcome}。
   */
  async function runBatch(
    button: HTMLButtonElement,
    action: (ids: readonly number[]) => Promise<BatchOutcome>,
  ): Promise<void> {
    const ids = [...selected]
    if (ids.length === 0) return

    setStatus('')
    // 先禁用挡住双击；最终状态由 renderSelection() 在重画之后统一决定。
    button.disabled = true

    try {
      const outcome = await action(ids)

      if (outcome.cancelled) {
        // 用户自己取消的：选中集原样保留，他能立刻换个目录再试一次。
        renderSelection()
        return
      }

      setStatus(outcome.message)
      selected.clear()
      await refresh()
    } catch (error) {
      setStatus(`操作失败：${asMessage(error)}`)
      renderSelection()
    }
  }

  exportButton.addEventListener('click', () => {
    void runBatch(exportButton, async (ids) => {
      const outcome = await bridge().exportArchive({ ids })

      // `null` = 用户在目录对话框里取消。不是错误，界面不留任何痕迹。
      if (outcome === null) return { cancelled: true }

      return {
        cancelled: false,
        message: outcome.ok
          ? describeExportResult(outcome)
          : describeExportRejection(outcome.reason, outcome.detail),
      }
    })
  })

  deleteButton.addEventListener('click', () => {
    void runBatch(deleteButton, async (ids) => {
      const outcome = await bridge().deleteArchive({ ids })

      // `null` = 用户在确认框里取消。
      if (outcome === null) return { cancelled: true }

      return {
        cancelled: false,
        message: outcome.ok
          ? describeDeleteResult(outcome)
          : describeDeleteRejection(outcome.reason, outcome.detail),
      }
    })
  })

  selectAll.addEventListener('change', () => {
    if (selectAll.checked) {
      for (const record of visible) selected.add(record.id)
    } else {
      selected.clear()
    }

    // 重画而不是逐个改 `checked`：行的复选框状态与选中集只有 render() 一处对应关系，
    // 分头同步就有机会不一致（这正是"勾了却没选上"那类 bug 的来源）。
    render(visible)
  })

  search.addEventListener('input', () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      // 换了搜索词就是换了一批结果，上一条结果行（"已导出 3 个文件…"）到此为止。
      setStatus('')
      void refresh()
    }, SEARCH_DEBOUNCE_MS)
  })

  refreshButton.addEventListener('click', () => {
    setStatus('')
    void refresh()
  })

  return { refresh }
}

function describeOpen(outcome: OpenOutcome): string | null {
  if (outcome.ok) return null
  switch (outcome.reason) {
    case 'not-found':
      return '归档里已经没有这个文件了（可能被清理过）。重新在聊天里点一次即可。'
    case 'no-application':
      return '系统里没有能打开这种文件的应用。用「在文件夹中显示」拿到它，再手动选择应用。'
    case 'failed':
      return '打开失败，原因见主进程日志。'
  }
}

function describeReveal(outcome: RevealOutcome): string | null {
  if (outcome.ok) return null
  return outcome.reason === 'not-found' ? '归档里已经没有这个文件了。' : '文件管理器没有响应。'
}

/**
 * 统计行。**只**写它自己那个元素 —— 结果行走 `mountArchiveView()` 里的 `setStatus()`。
 *
 * 它收的是元素而不是闭包里的那个变量：这个函数在 `mountArchiveView()` 之外，看不到它的作用域。
 */
async function renderFooter(records: readonly ArchiveRecord[], footer: HTMLElement): Promise<void> {
  try {
    const stats = await bridge().archiveStats()
    const shown = records.length === PAGE_SIZE ? `（仅显示最近 ${PAGE_SIZE} 条）` : ''

    /**
     * 密文缓存的占用**必须**显出来（[ADR-0049]）：它有一个可调的上限，而"现在占了多少"是
     * 用户判断那个上限该设多大的唯一依据 —— 在此之前这个数字根本不存在（`cacheBytes` 写死 0）。
     * 缓存关掉时它是 0，也就不显示。
     */
    const cache = stats.cacheBytes > 0 ? `；密文缓存 ${formatBytes(stats.cacheBytes)}` : ''

    footer.textContent = `${stats.fileCount} 个文件，占用 ${formatBytes(stats.totalBytes)}${cache}${shown}`
  } catch {
    // 统计失败不影响列表本身 —— 页脚清空而不是留一句过期的数字。
    footer.textContent = ''
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
