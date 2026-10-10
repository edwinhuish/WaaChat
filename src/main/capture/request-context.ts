/**
 * 直通重发时把原请求的 fetch 元数据补回去（[ADR-0058]）。
 *
 * ## 为什么需要这个模块
 *
 * 会话级 `protocol.handle('https')` 会接住分区里的**所有** https 请求，除媒体 CDN 之外的
 * 一律走直通（`protocol.ts` 的设计点 2）。但直通只能靠 `ses.fetch` 重发这份请求，而
 * Electron 的 `net.fetch` 重发时 Chromium 把它当成**主进程发起的、没有上下文的请求**，
 * 于是原请求上的 fetch 元数据全部退化（Electron 44.7 实测）：
 *
 * ```
 * 原生（渲染进程发起的 iframe 导航）
 *   sec-fetch-site: same-origin   sec-fetch-mode: navigate   sec-fetch-dest: iframe
 *   referer: https://…/parent
 * 直通重发（我们的 ses.fetch）
 *   sec-fetch-site: none          sec-fetch-mode: no-cors    sec-fetch-dest: empty
 *   （没有 referer）
 * ```
 *
 * 这不是"少几个头"那么轻：上游 `webtp.whatsapp.net/pdf-viewer/` **按这些头直接决定回哪一份**。
 * 实测（curl，2026-10-10；同一 URL、同一时刻，只改这几个请求头）：
 *
 * | 请求 | 上游响应 |
 * |---|---|
 * | 像真浏览器导航（`Mode: navigate` / `Dest: iframe` / 带 `Referer`） | 200，**59 KB** 的 `<html id="whatsapp-web-pdf-viewer">`（真正的 viewer），带 `cross-origin-resource-policy: cross-origin`、CSP（含 `frame-ancestors https://*.whatsapp.com`）与 `cache-control` |
 * | 无上下文（`Mode: no-cors` / `Dest: empty`，无 `Referer`） | 200，**183 KB** 的 `<html id="facebook">` —— Meta 的通用外壳（没有 CSP、没有 CORP、没有 `cache-control`） |
 *
 * ⚠️ 两份的 `Vary` 都只列 `Accept-Encoding`：这是**服务端按头分支**，不是内容协商缓存 ——
 * 因此"少补一个头"不会命中缓存里那份好的，而是每次拿到外壳。那个页面是被
 * `web.whatsapp.com`（带 `cross-origin-embedder-policy: require-corp`）用 iframe 嵌进去的，
 * 拿着外壳的表现就是**预览面板一直转圈**（外壳没有 viewer 的引导脚本）。
 *
 * ## 怎么补
 *
 * `protocol.handle` 拿到的 `Request` 上已经**没有**这些头（`request.headers` 里只有
 * `accept` / `sec-ch-ua*` / `user-agent` / `upgrade-insecure-requests`），但
 * `webRequest.onBeforeRequest` 仍然能看到每个请求的**角色**（`resourceType`）与原
 * `referrer` —— 即使密文层挂着，它也照常触发（实测）。所以：
 *
 *  1. `onBeforeRequest` 里把角色记下来（按 `method + url` 排队）；
 *  2. 直通重发前按排队顺序取出，换算成该请求在真浏览器里会带的 `Sec-Fetch-*`，
 *     并把 `referer` 补回去。
 *
 * 只有**认得出角色**的请求才记：我们重发出去的那一份 `resourceType` 恒为 `other`，
 * 因此记不进队列，队列不会自己喂自己。
 *
 * ## 补不回去的那一个
 *
 * `Sec-Fetch-Site` **补不了**：它是 Chromium 按请求的 initiator 现算的，主进程发起的
 * 请求恒为 `none`，显式写一个值也会被内核覆盖（实测）。上游对 `none` 是容忍的 ——
 * 只要 `Sec-Fetch-Mode` 正确，拿到的仍是可内嵌的那一份变体（见上表）。这就是本模块
 * 只补 `Mode` / `Dest` / `User` 与 `Referer` 的原因。
 *
 * ## `Mode` 只有两种取值能用
 *
 * `navigate` 与 `no-cors`。其余取值（真浏览器在 XHR / `fetch()` 上发的 `cors`，以及
 * `same-origin`）会让重发**根本发不出去**：`ses.fetch` 直接以 `net::ERR_INVALID_ARGUMENT`
 * 失败，而那种失败在日志里只有一行 stderr。实测数据与受影响的那一个角色见
 * `FETCH_METADATA_BY_RESOURCE_TYPE` 的注释 —— 补错比不补坏得多。
 *
 * 不导入 electron（判据与 IO 分开，单测与离线自检都能断言），因此入参用结构化类型。
 */

/** 浏览器在真实请求里会带的 `Sec-Fetch-*` 三元组之一。 */
export interface FetchMetadata {
  readonly mode: string
  readonly dest: string
  readonly user?: string
}

/** 原请求的角色与原 `referer`：直通重发时要还原的两样东西。 */
export interface OriginalRequestContext {
  readonly metadata: FetchMetadata
  readonly referrer: string
}

/**
 * Chromium 的 `resourceType` → 该请求在真浏览器里会带的 `Sec-Fetch-*`。
 *
 * 取值依据是 Fetch Metadata 规范：导航是 `navigate`/`document`（顶层，带 `?1`），
 * 子框架是 `navigate`/`iframe`，其余（脚本 / 样式表 / 图片 / 字体 / 对象 / ping …）
 * 都是 `no-cors` 加各自资源类型的 dest。
 *
 * ⚠️ **`mode` 只能是 `navigate` 或 `no-cors`。** 实测（Electron 44.7，`net.fetch` 与
 * `ses.fetch` 都一样）：带上 `Sec-Fetch-Mode: cors`（或 `same-origin`）的那一份请求
 * **根本发不出去**，直接以 `net::ERR_INVALID_ARGUMENT` 失败；另外 `dest` 是
 * `document` / `frame` / `iframe` / `fencedframe` 时必须配 `navigate`，否则报
 * `sec-fetch-dest of '…' requires sec-fetch-mode 'navigate'`。
 *
 * 刻意**不**收录这几种：
 *  - **`xhr`**：真浏览器发的是 `cors`/`empty`，而 `cors` 正是上面那条被内核拒收的取值 ——
 *    补不了。内核默认给它的恰好就是 `no-cors`/`empty`，因此"不收录"等于维持原状；
 *    收录了才是灾难：分区里每一个 XHR / `fetch()` 都会被 `ERR_INVALID_ARGUMENT` 打掉。
 *  - **`other`**：正是我们自己重发出去的那一份，收录它会让队列自己喂自己。
 *  - **`webSocket`**：不经过这里（协议层只接 https）。
 *  - **`media`**：Chromium 会给 `video`/`audio` 两种 dest 之一，而 `resourceType`
 *    分不出来 —— 宁可少补（维持内核默认），也不补一个错的。
 */
export const FETCH_METADATA_BY_RESOURCE_TYPE: Readonly<Record<string, FetchMetadata>> = {
  mainFrame: { mode: 'navigate', dest: 'document', user: '?1' },
  subFrame: { mode: 'navigate', dest: 'iframe' },
  stylesheet: { mode: 'no-cors', dest: 'style' },
  script: { mode: 'no-cors', dest: 'script' },
  image: { mode: 'no-cors', dest: 'image' },
  font: { mode: 'no-cors', dest: 'font' },
  object: { mode: 'no-cors', dest: 'object' },
  ping: { mode: 'no-cors', dest: 'empty' },
  cspReport: { mode: 'no-cors', dest: 'report' },
}

/** 每个 `method + url` 最多排几个 —— 同一个 URL 并发请求时够用了。 */
const MAX_QUEUE = 8

/**
 * 队列最多记多少个 key。
 *
 * 正常情形下"记下 → 立刻被重发取走"是紧挨着的，因此队列几乎恒为空；这个上限只是防止
 * 异常路径（比如请求被取消、重发没发生）把它撑大。溢出时丢最早插入的那个 key ——
 * 丢一条的角色比不封顶更安全，最坏也就是那一个请求维持内核默认行为（与修复前一致）。
 */
const MAX_KEYS = 256

const queues = new Map<string, OriginalRequestContext[]>()

function keyOf(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`
}

/** `onBeforeRequest` 的入参见 `electron.d.ts`；这里只取需要的四个字段。 */
export interface RequestRoleDetails {
  readonly method: string
  readonly url: string
  readonly resourceType: string
  readonly referrer: string
}

/** 记下原请求的角色与原 `referer`，等直通重发时取走。认不出角色的请求直接忽略。 */
export function rememberRequestContext(details: RequestRoleDetails): void {
  const metadata = FETCH_METADATA_BY_RESOURCE_TYPE[details.resourceType]
  if (metadata === undefined) return

  const key = keyOf(details.method, details.url)

  if (queues.size >= MAX_KEYS && !queues.has(key)) {
    const oldest = queues.keys().next()
    if (!oldest.done) queues.delete(oldest.value)
  }

  const queue = queues.get(key) ?? []
  if (queue.length >= MAX_QUEUE) queue.shift()
  queue.push({ metadata, referrer: details.referrer })
  queues.set(key, queue)
}

/**
 * 把原请求的 fetch 元数据补回这份将要重发的请求上（就地改 `request.headers`）。
 *
 * 取不到记录时只补 `referer`（它本来就挂在 `Request` 上），其余维持内核默认 ——
 * 与修复前的行为一致，不会更糟。
 */
export function applyRequestContext(request: Request): void {
  const context = takeContext(keyOf(request.method, request.url))

  const referrer = refererOf(request, context)
  if (referrer !== '') request.headers.set('Referer', referrer)

  if (context === undefined) return

  request.headers.set('Sec-Fetch-Mode', context.metadata.mode)
  request.headers.set('Sec-Fetch-Dest', context.metadata.dest)
  if (context.metadata.user !== undefined) {
    request.headers.set('Sec-Fetch-User', context.metadata.user)
  }
}

/**
 * 该写哪个 `Referer`。
 *
 * `Request.referrer` 有两个**不是 URL** 的哨兵值：`''`（no-referrer）与 `about:client`
 * （"跟调用方一样"，`new Request(url)` 的默认值）。把 `about:client` 当地址写进
 * `Referer` 会造出一份畸形的请求，因此只接受真正是 URL 的那一种。
 */
function refererOf(request: Request, context: OriginalRequestContext | undefined): string {
  if (context !== undefined && context.referrer !== '') return context.referrer

  const referrer = request.referrer
  return referrer === '' || referrer === 'about:client' ? '' : referrer
}

function takeContext(key: string): OriginalRequestContext | undefined {
  const queue = queues.get(key)
  if (queue === undefined) return undefined

  const context = queue.shift()
  if (queue.length === 0) queues.delete(key)
  return context
}

/** 摘掉密文层时清空（[ADR-0027] 的切换会来回走，留着只会串味）。 */
export function clearRequestContexts(): void {
  queues.clear()
}
