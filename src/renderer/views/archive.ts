/**
 * 文件列表窗口的主体（前身是「归档」标签页，见 ADR-0025）。
 *
 * 这是整个应用的使用面：文件被接管后落进**归档**（数据层的概念，见 ADR-0018），
 * 用户在这扇窗口里找它、打开它、在文件管理器里定位它。
 *
 * 一个容易写错、且症状很难归因的地方：**搜索的竞态**。用户在搜索框里快速输入时
 * 会发出多个请求，而它们不保证按顺序返回。不做处理的话，先发的慢请求会覆盖后发的
 * 快请求，用户看到的结果与输入框里的字**对不上**。下面的 `requestId` 就是为此存在。
 */

import type { ArchiveRecord, OpenOutcome, RevealOutcome } from '../../shared/types'
import { formatBytes, formatTimestamp } from '../../shared/format'
import { bridge } from '../bridge'
import { clear, h } from '../dom'

/** 一次取多少条。界面是列表而不是分页器，够用即可。 */
const PAGE_SIZE = 100

/** 搜索防抖。太短会在快速输入时打出无意义的请求，太长会让人觉得卡。 */
const SEARCH_DEBOUNCE_MS = 180

export interface ArchiveView {
  refresh(): Promise<void>
}

export function mountArchiveView(
  list: HTMLElement,
  footer: HTMLElement,
  search: HTMLInputElement,
  refreshButton: HTMLButtonElement,
): ArchiveView {
  let requestId = 0
  let debounce: ReturnType<typeof setTimeout> | undefined

  async function refresh(): Promise<void> {
    const current = ++requestId

    try {
      const records = await bridge().listArchive({ text: search.value, limit: PAGE_SIZE })
      if (current !== requestId) return // 有更新的请求在路上，丢弃本次结果。

      render(records)
      await renderFooter(records, footer)
    } catch (error) {
      if (current !== requestId) return
      clear(list)
      list.append(
        h('li', {}, h('div', { class: 'empty', text: `读取归档失败：${asMessage(error)}` })),
      )
    }
  }

  function render(records: readonly ArchiveRecord[]): void {
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
      return
    }

    for (const record of records) {
      list.append(archiveRow(record, refresh, footer))
    }
  }

  search.addEventListener('input', () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => void refresh(), SEARCH_DEBOUNCE_MS)
  })

  refreshButton.addEventListener('click', () => void refresh())

  return { refresh }
}

/**
 * 一行归档记录。
 *
 * 注意文件名走 `textContent`（`h()` 的 `text` 属性）而不是 `innerHTML`：
 * 这个字符串来自对端发送者，拼进标记里就是我们自己造的注入点。
 */
function archiveRow(
  record: ArchiveRecord,
  refresh: () => Promise<void>,
  footer: HTMLElement,
): HTMLLIElement {
  const openButton = h('button', {
    class: 'action',
    type: 'button',
    text: '打开',
    onClick: () =>
      void runAction(
        openButton,
        () => bridge().openArchive({ id: record.id }),
        describeOpen,
        footer,
        refresh,
      ),
  })

  const revealButton = h('button', {
    class: 'action',
    type: 'button',
    text: '在文件夹中显示',
    onClick: () =>
      void runAction(
        revealButton,
        () => bridge().revealArchive({ id: record.id }),
        describeReveal,
        footer,
        refresh,
      ),
  })

  const sub = [formatBytes(record.bytes), formatTimestamp(record.openedAt)]
  if (record.mime !== '') sub.push(record.mime)
  if (record.chatLabel !== undefined) sub.push(record.chatLabel)

  return h(
    'li',
    {},
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
 * 跑一个动作并把结果反馈到页脚。
 *
 * 失败**必须**说出来：这一层的失败模式（归档被清理、系统没有关联应用）都会让用户
 * 以为是自己的操作错了。静默失败是 `ai/CONVENTIONS.md` 第 4 节明确禁止的。
 */
async function runAction<T extends OpenOutcome | RevealOutcome>(
  button: HTMLButtonElement,
  action: () => Promise<T>,
  describe: (outcome: T) => string | null,
  footer: HTMLElement,
  refresh: () => Promise<void>,
): Promise<void> {
  button.disabled = true
  try {
    const outcome = await action()
    const message = describe(outcome)
    if (message !== null) footer.textContent = message
    // 打开过的文件其"打开时间"会更新（索引里是 upsert），因此刷新一次列表。
    await refresh()
  } catch (error) {
    footer.textContent = `操作失败：${asMessage(error)}`
  } finally {
    button.disabled = false
  }
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
