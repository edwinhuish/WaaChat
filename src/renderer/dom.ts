/**
 * 极小的 DOM 构造助手。
 *
 * 刻意**不**引入框架：整个界面就是三个列表和一个表单，框架带来的构建配置、
 * 版本升级与安全公告不值得。但"手写 DOM 于是到处是 `innerHTML` 拼接"也不行 ——
 * 归档里的文件名来自**对端发送者**，拼进 `innerHTML` 就是我们自己造的 XSS。
 *
 * 因此本文件的存在有一个明确目的：让 `textContent` 成为**最省事的写法**。
 * 全项目（`src/renderer/`）不允许出现 `innerHTML`。
 */

/** `h()` 支持的属性。刻意收窄：没有 `innerHTML`，也没有任意属性透传。 */
export interface ElementProps {
  readonly class?: string
  /** 文本内容。走 `textContent`，因此天然免疫标记注入。 */
  readonly text?: string
  readonly title?: string
  /** 数据锚点，写成 `data-role="name"`。刻意不叫 `role` —— 那个名字属于 ARIA。 */
  readonly dataRole?: string
  /**
   * 额外的 `data-*` 属性，写成 `data={{ state: 'ok' }}` → `data-state="ok"`。
   *
   * 样式钩子走这里，而不是给每个状态各加一个 class —— class 是给"长什么样"用的，
   * `data-*` 是给"是什么状态"用的，两者混在一起之后，改样式就会弄坏状态选择器。
   */
  readonly data?: Readonly<Record<string, string>>
  readonly type?: string
  readonly placeholder?: string
  readonly value?: string
  readonly disabled?: boolean
  /** 复选框 / 单选框的选中态。 */
  readonly checked?: boolean
  /**
   * 事件回调的参数类型刻意是 `Event` 而不是 `MouseEvent`。
   *
   * 因为 `element` 的类型是 `HTMLElementTagNameMap[K]` 这样的泛型索引访问，
   * TypeScript 选不出 `addEventListener` 的某个具体重载，只认 `(event: Event) => void`。
   * 用 `Event` 之后调用方需要自己窄化（`event.target as HTMLInputElement`）——
   * 那本来也是应该显式做的事。
   */
  readonly onClick?: (event: Event) => void
  readonly onChange?: (event: Event) => void
  readonly onInput?: (event: Event) => void
}

type Child = Node | string | null | undefined | false

/**
 * 创建元素。
 *
 *   h('span', { class: 'muted', text: formatBytes(bytes) })
 *   h('li', { class: 'row' }, h('span', { text: record.name }), openButton)
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)

  if (props.class !== undefined) element.className = props.class
  if (props.text !== undefined) element.textContent = props.text
  if (props.title !== undefined) element.title = props.title
  if (props.dataRole !== undefined) element.dataset['role'] = props.dataRole
  if (props.data !== undefined) {
    for (const [key, value] of Object.entries(props.data)) element.dataset[key] = value
  }
  if (props.type !== undefined) element.setAttribute('type', props.type)
  if (props.placeholder !== undefined) element.setAttribute('placeholder', props.placeholder)
  if (props.value !== undefined) element.setAttribute('value', props.value)
  if (props.disabled === true) element.setAttribute('disabled', '')
  if (props.checked === true) element.setAttribute('checked', '')
  if (props.onClick !== undefined) element.addEventListener('click', props.onClick)
  if (props.onChange !== undefined) element.addEventListener('change', props.onChange)
  if (props.onInput !== undefined) element.addEventListener('input', props.onInput)

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    element.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }

  return element
}

/** 清空容器。比 `innerHTML = ''` 更明确，也不会触发 HTML 解析。 */
export function clear(node: Element): void {
  node.replaceChildren()
}

/**
 * 按 `data-role` 找子元素。
 *
 * 比 `querySelector('.row .name')` 稳：类名是给样式用的，改样式不该弄坏脚本。
 * 找不到时抛错而不是返回 `null` —— 界面结构与脚本不匹配属于**编码错误**，
 * 应该立刻炸出来，而不是让某个字段静默显示为空。
 *
 * 参数是 `ParentNode`（`document` 与 `Element` 都满足），因为入口处需要从
 * `document` 开始找。
 */
export function part<T extends Element = HTMLElement>(root: ParentNode, role: string): T {
  const found = root.querySelector<T>(`[data-role="${role}"]`)
  if (found === null) throw new Error(`ui: 缺少 data-role="${role}" 的节点`)
  return found
}
