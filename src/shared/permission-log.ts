/**
 * "我们拒了某个权限"这条日志的簿记（[ADR-0085]）。
 *
 * ── 为什么需要一个簿记 ──
 *
 * 权限判据是**每一次请求、每一次检查**都要过的一道闸，而内核会反复问同一件事
 * （`persistent-storage`、`notifications` 在页面每次初始化时都要查一遍）。逐条记的后果不只是
 * "日志太多"：它会把真正有用的那几行挤到看不见 —— 而 `permission denied` 恰恰是用户唯一能自己
 * 判断"这个功能没反应是不是被我们拒了"的线索（[ADR-0035]）。
 *
 * **规则：每一组（哪条路 + 哪一项权限 + 是不是上游源）只记第一次。**
 *
 * ⚠️ "只记第一次"不会掩盖关键证据：我们要的证据是"这一组**出现过**"，出现多少次与它是谁无关。
 * 而**新的**组合 —— 例如上游第一次请求 `display-capture` —— 一定是第一次，因此必然出现在日志里。
 *
 * 纯函数，因此单测与离线自检都能直接断言（与 `shared/notice.ts` 的几条 tracker 同形）。
 */

/**
 * 拒绝是从哪条路来的。
 *
 * `request` = 内核真的在发起请求（`setPermissionRequestHandler`）；
 * `check` = 只查了权限（`setPermissionCheckHandler`）。
 *
 * 分开记的理由：有些 Web API **只检查不请求**。那种情形下"只有检查被拒"是我们唯一能看到的
 * 信号（[ADR-0085]），而它对应的上游功能可能根本没走到"请求"那一环。
 */
export type DenialPath = 'request' | 'check'

/** 一条"我们拒了"的记录。 */
export interface DenialEntry {
  readonly path: DenialPath
  /** 上游请求的那一项权限，**原样**字符串（上游将来引入的新类型也会原样到这儿）。 */
  readonly permission: string
  /** 发起方是不是我们承载的那个源。 */
  readonly fromUpstream: boolean
}

/** {@link trackDenial} 的结果。 */
export interface DenialTracking {
  /** 这一条要不要记。 */
  readonly log: boolean
  /** 记完之后的新集合。 */
  readonly seen: ReadonlySet<string>
}

/**
 * 组合的键。
 *
 * 用这三项而不是单个权限名：同一种权限"被上游请求"与"被一个第三方页面检查"是两件事，
 * 而把两者混成一个键的后果是"后者先出现时把前者静音了"。
 */
export function denialKey(entry: DenialEntry): string {
  return `${entry.path}:${entry.permission}:${entry.fromUpstream ? 'upstream' : 'foreign'}`
}

export function trackDenial(seen: ReadonlySet<string>, entry: DenialEntry): DenialTracking {
  const key = denialKey(entry)

  return { log: !seen.has(key), seen: new Set([...seen, key]) }
}
