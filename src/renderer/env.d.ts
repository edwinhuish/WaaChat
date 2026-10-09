/**
 * 渲染进程的全局声明。
 *
 * `window.waachat` 由 preload 注入（`contextBridge.exposeInMainWorld`），TypeScript
 * 看不到那一步，因此需要在这里补上类型。这个文件**只放声明** —— 取桥的辅助函数
 * 在 `bridge.ts`（`.d.ts` 里不能有实现）。
 */

import type { WaaChatBridge } from '../shared/bridge'

declare global {
  interface Window {
    readonly waachat?: WaaChatBridge
  }
}

export {}
