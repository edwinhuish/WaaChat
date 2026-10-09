/**
 * 取 preload 注入的桥。
 *
 * 拿不到就直接抛 —— 这是**装配错误**（preload 路径写错、preload 构建格式与
 * `sandbox: true` 不兼容之类），不是运行时环境问题。静默降级会让这类错误表现为
 * "界面一片空白、控制台什么也没有"，排查成本极高。
 */

import type { WaaChatBridge } from '../shared/bridge'

export function bridge(): WaaChatBridge {
  const api = window.waachat
  if (api === undefined) {
    throw new Error('ui: window.waachat 不存在 —— preload 没有加载成功')
  }
  return api
}
