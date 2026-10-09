/**
 * 缓存响应**回放时保留哪些响应头**。
 *
 * 单独成模块，是为了能被离线自检断言（`scripts/check-capture.ts`）—— 这份清单错一个的
 * 后果是"页面局部坏掉而且不报错"，属于本项目最想拦住的那一类问题。
 *
 * 两条判据：
 *
 *  1. **逐次变化的头不写**（`date`、`x-fb-debug`、`report-to` …）：写进去只会让缓存文件
 *     随请求抖动，没有语义价值。
 *  2. **会改变浏览器如何处置这份响应的头必须写。** 漏掉第 2 类的症状是静默的：
 *     实测 `web.whatsapp.com` 带 `cross-origin-embedder-policy: require-corp`，而它把文档
 *     预览放在 iframe 里（它自己的 CSP `frame-src` 就列了 `https://webtp.whatsapp.net`）。
 *     缓存只回 `content-type` 时，那个子文档被判为"未启用 COEP、不可嵌入" ⇒
 *     `ERR_BLOCKED_BY_RESPONSE`，预览直接打不开。依据见 ADR-0016。
 *
 * 为什么是白名单，而不是"除了几个之外全存"：`cache/` 的性质声明是"里面只有密文"
 * （docs/security.md）。黑名单只要漏掉一个 `set-cookie`，凭据就落进了那个目录。
 *
 * ⚠️ **绝不能回放 `content-encoding`**：正文来自 `net.fetch`，按 fetch 语义已经是解码后的
 * 字节，带上它会让浏览器再解一次。这也是"白名单"的另一个理由。
 *
 * ⚠️ 上游将来新增一个"决定能不能用"的头（`permissions-policy`、`document-policy` …）时，
 * 必须在这里补上。
 */
export const CARRIED_HEADERS: readonly string[] = [
  // 正文本身的描述
  'content-type',
  'content-length',
  'content-disposition',

  // 条件校验
  'etag',
  'last-modified',

  // 跨源策略：COEP 的父文档里，子资源与子文档靠这几个头才被允许加载
  'cross-origin-resource-policy',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'access-control-allow-origin',

  // 文档自己的策略：回放一份文档时，它必须与回源时拥有同样的约束
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
]

/** 从一份响应头里挑出要落盘、回放时要原样带上的部分。 */
export function carriedHeaders(from: { get(name: string): string | null }): Record<string, string> {
  const headers: Record<string, string> = {}

  for (const name of CARRIED_HEADERS) {
    const value = from.get(name)
    if (value !== null) headers[name] = value
  }

  return headers
}
