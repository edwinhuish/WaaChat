/**
 * 认领"页面自己那条通知被点了"（[ADR-0096]）：判据全在这里，IO 在 `main/notify-activation.ts`。
 *
 * 为什么需要这份簿记：页面通知的点击在 Linux 上只被派发给**页面**，主进程没有任何事件
 * （[ADR-0092] 证据 1）。唯一拿得到的信号是会话总线上那条 `ActionInvoked(id, "default")`
 * —— 而它是**发给发起 `Notify` 的那个连接**的，总线上同时还跑着别人的通知。于是问题变成
 * "这个 id 是不是我发的"，答案有两条路，这里两条都记：
 *
 *   1. **按 id**：我们自己那条 `Notify` 的 serial → 它的回复里那个由守护进程分配的 id。
 *      这条路不依赖守护进程怎么发信号，但要等回复；
 *   2. **按连接**：`ActionInvoked` 的 `destination` 就是发起者。我们自己那条 libnotify 连接的
 *      unique name 由调用方按 `ProcessID == 本进程 pid` 核实后交进来。
 *
 * ⚠️ 两条路之间有**竞态**：`Notify` 的回复可能在 `GetConnectionCredentials` 回来**之前**就到，
 * 那时 serial 还没进 `pendingSerials`。因此回复要先进一个有上限的 `recentReturns` 缓冲，等
 * 认领成立再回头比对 —— 否则"第一次点击不生效、之后才正常"这种间歇性缺陷会很难查。
 *
 * 为什么不是有状态的类：`shared/` 只放纯函数（`ai/CONVENTIONS.md` 第 2 节），而这份状态的每一步
 * 都能被单测直接喂进去。
 */

/** 同时保留的条目上限。与 `main/notice.ts` 的 `live` 同义：防泄漏，不是语义。 */
export const CLAIM_LIMIT = 64

/**
 * 从 `GetConnectionCredentials` 的返回值里取出 `ProcessID`。
 *
 * ⚠️ **两种形状都要照顾，这是实测出来的，不是猜的**：dbus-next 把 `a{sv}` 解成**普通对象**
 * （不是 `Map`），值是它自己的 `Variant`（`{ signature, value }`）。按 `Map` 写会得到
 * `ProcessID === null` ⇒ 两条认领路径全都不成立 ⇒ 整条通道**静默失效**，而日志里只有
 * "点击信号来了、但没认领"，看起来像守护进程的问题。踩过一次，因此这里也钉了单测。
 */
export function processIdFromCredentials(credentials: unknown): number | null {
  const raw = readCredential(credentials, 'ProcessID')
  const value = isVariantLike(raw) ? raw.value : raw
  return typeof value === 'number' ? value : null
}

function readCredential(credentials: unknown, key: string): unknown {
  if (credentials instanceof Map) return credentials.get(key) as unknown
  if (typeof credentials !== 'object' || credentials === null) return null
  if (!(key in credentials)) return null
  return (credentials as Record<string, unknown>)[key]
}

function isVariantLike(value: unknown): value is { readonly value: unknown } {
  return typeof value === 'object' && value !== null && 'value' in value
}

/**
 * `recentReturns` 的上限。
 *
 * 比 {@link CLAIM_LIMIT} 小得多是有意的：它只覆盖"回复先于 PID 核实到达"那个毫秒级窗口，
 * 保留 16 条已经远超实际需要，同时把"一直在收别人的 `Notify` 回复"这种情形挡在外面。
 */
export const RECENT_RETURN_LIMIT = 16

export interface ClaimState {
  /** 我们自己那条连接发出去的 `Notify` 的 serial，正等它的回复给出 id。 */
  readonly pendingSerials: readonly number[]
  /** 已确认属于本进程的连接名（`ActionInvoked` 的 `destination` 会是它）。 */
  readonly ownSenders: readonly string[]
  /** 守护进程分配给我们自己那条通知的 id（`ActionInvoked` 带的就是它）。 */
  readonly ownIds: readonly number[]
  /** 还没对上的 `Notify` 回复。见文件头那段竞态说明。 */
  readonly recentReturns: readonly NotificationReturn[]
}

export interface NotificationReturn {
  readonly replySerial: number
  readonly notificationId: number
}

export const EMPTY_CLAIM: ClaimState = {
  pendingSerials: [],
  ownSenders: [],
  ownIds: [],
  recentReturns: [],
}

/** 尾部追加并裁掉最老的，长度上限 `limit`。 */
function pushBounded<T>(list: readonly T[], value: T, limit: number): readonly T[] {
  const next = [...list, value]
  return next.length > limit ? next.slice(next.length - limit) : next
}

/**
 * 一条 `Notify` 的 sender 已被核实为本进程（PID 相同）。
 *
 * ⚠️ 调用方**必须**先做完 PID 核实再调这里 —— 这个函数本身不判断"是不是我们的"，
 * 它只记账。把判断与记账分开是为了让两条路都能单测。
 */
export function claimOwnNotify(
  state: ClaimState,
  frame: { readonly sender: string; readonly serial: number },
): ClaimState {
  const withSender = state.ownSenders.includes(frame.sender)
    ? state
    : { ...state, ownSenders: pushBounded(state.ownSenders, frame.sender, CLAIM_LIMIT) }

  // 回复先到的情形：直接从缓冲里把 id 认领掉，不必再等。
  const matched = state.recentReturns.filter((entry) => entry.replySerial === frame.serial)
  if (matched.length > 0) {
    const ids = matched.map((entry) => entry.notificationId)
    return {
      ...withSender,
      ownIds: [...withSender.ownIds, ...ids].slice(-CLAIM_LIMIT),
      recentReturns: state.recentReturns.filter((entry) => entry.replySerial !== frame.serial),
    }
  }

  return {
    ...withSender,
    pendingSerials: pushBounded(withSender.pendingSerials, frame.serial, CLAIM_LIMIT),
  }
}

/**
 * 一条 `Notify` 的回复（守护进程分配的 id）。
 *
 * 对不上任何 pending serial 时**不丢**，进 {@link ClaimState.recentReturns} 等 PID 核实回来 ——
 * 那正是"回复比核实快"的那一半。
 */
export function claimNotificationId(state: ClaimState, entry: NotificationReturn): ClaimState {
  if (!state.pendingSerials.includes(entry.replySerial)) {
    return {
      ...state,
      recentReturns: pushBounded(state.recentReturns, entry, RECENT_RETURN_LIMIT),
    }
  }

  return {
    ...state,
    pendingSerials: state.pendingSerials.filter((serial) => serial !== entry.replySerial),
    ownIds: pushBounded(state.ownIds, entry.notificationId, CLAIM_LIMIT),
  }
}

/**
 * 一条 `ActionInvoked`：这个 id 是不是我们发的？
 *
 * 两条路任一成立就算认领（见文件头）：id 在册，或者它是发给我们自己那条连接的。
 * 认领之后把 id 移出册子 —— 同一条通知被点两次不会发生（[ADR-0092] 已知限制 2）。
 */
export function decideClick(
  state: ClaimState,
  frame: { readonly notificationId: number; readonly destination: string | null },
): { readonly state: ClaimState; readonly activate: boolean } {
  const byId = state.ownIds.includes(frame.notificationId)
  const byConnection = frame.destination !== null && state.ownSenders.includes(frame.destination)

  if (!byId && !byConnection) return { state, activate: false }

  return {
    state: { ...state, ownIds: state.ownIds.filter((id) => id !== frame.notificationId) },
    activate: true,
  }
}

/**
 * `NotificationClosed`：这条通知没了，id 也不必再留着。
 *
 * Linux 上这个信号**不保证发出**（[ADR-0092] 已知限制 3），所以上限才是真正的兜底。
 */
export function releaseClosed(state: ClaimState, notificationId: number): ClaimState {
  if (!state.ownIds.includes(notificationId)) return state
  return { ...state, ownIds: state.ownIds.filter((id) => id !== notificationId) }
}
