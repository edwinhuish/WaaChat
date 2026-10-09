/**
 * 装配失败的兜底提示。
 *
 * 这条路径只会因为**装配错误**走到（preload 没挂上、界面结构与脚本不匹配），
 * 不会是数据问题。因此直接把原因写在窗口里，而不是留一片空白 ——
 * 空白窗口会让排查者从"渲染进程为什么没起来"开始猜，那要走很远。
 *
 * 两个渲染入口共用它：文件列表与设置各是一个独立的 HTML 入口（[ADR-0025]），
 * 各自都需要这条兜底。
 */

export function fatal(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)

  const node = document.createElement('pre')
  node.textContent = `界面无法启动：\n\n${message}`
  node.setAttribute(
    'style',
    'padding:24px;white-space:pre-wrap;font-family:ui-monospace,monospace;color:#b42318',
  )

  document.body.replaceChildren(node)
}
