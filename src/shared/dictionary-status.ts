/**
 * 拼写词典的**下载状态**：一张状态机 + 键的归一化（[ADR-0071]）。
 *
 * 为什么它值得单独一个文件：内核只给**事件**，不给百分比 —— 词典请求由**浏览器进程**发出，
 * 既不经过 `protocol.handle`，也不经过 `webRequest`（[ADR-0068] 实测），我们能拿到的全部信息
 * 就是"某一门开始了 / 成功了 / 失败了 / 装载好了"。于是"进度条"要表达的东西必须是**状态**，
 * 而"事件 → 状态"这条映射一旦写错，症状是安静的：那一格停在"未开始"，而它与"这门词典本来
 * 就不需要下载"长得一模一样。
 *
 * 纯数据 + 纯函数：不 import electron、不碰 DOM、不碰文件系统，因此主进程、渲染进程、单测与
 * 离线自检都能用它（与 `language.ts` / `size-limit.ts` 同一个理由）。
 */

/**
 * 一门词典此刻的状态。
 *
 * - `unknown` —— 还没听到关于它的任何消息。**不是失败**：磁盘上本来就有这一门时，内核不会
 *   去下载，只会把它装载好（那时才发 `initialized`）。因此它读作"暂无状态"，而不是"没下载"。
 * - `downloading` —— 内核正在从下载源取它。
 * - `ready` —— 拿到了、并且已经交给检查器（或已经下好了）。
 * - `failed` —— 取不回来。这一支**没有别的症状**（设置页一切正常、输入框里却没有红线），
 *   因此它必须在界面上留下痕迹（[ADR-0061] 的已知限制）。
 */
export type DictionaryStatus = 'unknown' | 'downloading' | 'ready' | 'failed'

/**
 * 内核发出来的那四个事件里，与状态有关的那几点。
 *
 * 用字符串而不是 `boolean`：调用点是 `session.on(...)` 的四个订阅，写成字面量之后，
 * {@link watchSpellcheck} 里那一串订阅与这里的映射是逐条对得上的。
 */
export type DictionaryEvent =
  /** `spellcheck-dictionary-download-begin`：内核开始从下载源取这一门。 */
  | 'download-begin'
  /** `spellcheck-dictionary-download-success`：字节拿到了。 */
  | 'download-success'
  /** `spellcheck-dictionary-download-failure`：取不回来（会一直重试，见 `shared/notice.ts`）。 */
  | 'download-failure'
  /** `spellcheck-dictionary-initialized`：内核把这一门装好了 —— 磁盘上本来就有它时只会发这一个。 */
  | 'initialized'

/**
 * 状态迁移。
 *
 * 两条规则值得写下来：
 *
 *  1. **`download-begin` 把 `failed` 拉回 `downloading`。** 内核在成功之前会**反复重试**
 *     （每次输入时一次，见 `shared/notice.ts`），而"失败过"不该让之后的每一次尝试都不再显示 ——
 *     那会让"它还在试着救"变成"它已经放弃了"。
 *  2. **`ready` 不被降级。** 已经装载好的词典再收到一条失败消息是**说不通**的（文件就在磁盘上），
 *     而把绿条改回红条会让用户以为一块正常的词典坏了。"绿是终局"因此写在这里，而不是靠调用点保证。
 *
 * @param current 这一门此刻的状态；`undefined` 表示还没听到过它（等价于 `unknown`）
 */
export function nextDictionaryStatus(
  current: DictionaryStatus | undefined,
  event: DictionaryEvent,
): DictionaryStatus {
  if (current === 'ready' && event !== 'download-begin') return 'ready'

  switch (event) {
    case 'download-begin':
      return 'downloading'
    case 'download-success':
    case 'initialized':
      return 'ready'
    case 'download-failure':
      return 'failed'
  }
}

/**
 * 状态表与查询用的键：**大小写归一**。
 *
 * 为什么需要它：内核事件里的语言码用的是**我们交给它的那个形状**（实测磁盘上落下来的是
 * `en-US-10-1.bdic`，大小写原样保留），而设置里存的是 `en-US` —— 今天两边一模一样，
 * 但"逐字节相同"这条隐含约定没有任何地方保证。归一化之后，"哪种形状"不再是一个前提：
 * 不归一化时，万一哪天内核改用小写回传，症状是每一格都停在"未开始"，而它与"这门词典
 * 本来就不需要下载"看不出区别。
 *
 * ⚠️ **取值表与查询必须都经过它**（`main/spellcheck.ts` 与 `views/settings.ts` 各一处）。
 */
export function dictionaryKey(languageCode: string): string {
  return languageCode.toLowerCase()
}

/**
 * 一张"语言码（小写）→ 状态"的快照。跨 IPC 传的就是它。
 *
 * 用普通对象而不是 `Map`：它是**数据**，要能直接过结构化克隆（`Map` 也能，但对象更容易
 * 在日志与断言里读）。渲染进程按 `dictionaryKey()` 取，取不到按 `unknown` 处理。
 */
export type DictionaryStatusMap = Readonly<Record<string, DictionaryStatus>>
