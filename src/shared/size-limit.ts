/**
 * 容量上限（归档 / 密文缓存）在界面上的**状态**。
 *
 * 这个模块存在的唯一理由：这一行的"尚未生效"不能是一句**写死的话**。
 *
 * 之前的写法把徽标与提示文本直接写在渲染那一行里（`views/settings.ts`），于是它和
 * "主进程到底会不会按这个上限淘汰"这件事之间没有任何联系 —— 功能落地之后那句话不会自己
 * 消失，也没人会想起来改它；反过来，配置成"不限制"时它照样标着"尚未生效"，用户看到的
 * 是一句与他当前配置无关的话。两种都是同一类毛病：**状态提示没有反映实际配置**。
 *
 * 因此这里把三件事拼起来算出一个状态：
 *
 *   1. **当前值**（来自设置）：`0` 表示不限制；
 *   2. **这一项今天是否真的被执行**（[`SIZE_LIMIT_ENFORCED`]，唯一的事实来源）；
 *   3. **未实现时挂在哪个里程碑上**（写进提示，用户知道去哪儿看进度）。
 *
 * 纯函数、不碰 DOM、不碰文件系统 —— 因此主进程与界面都能用，也能被单测与离线自检直接断言
 * （`test/unit/size-limit.test.ts` / `scripts/check-capture.ts`）。
 */

import { formatBytes } from './format'

/** 两个容量项。键名与 `Settings` 里的字段一致，免得两处各起一套名字。 */
export type SizeLimitKey = 'archiveMaxBytes' | 'cacheMaxBytes'

/**
 * 今天这两项**是否真的被主进程执行** —— 界面上"尚未生效"徽标的唯一来源。
 *
 * 判据（改动这里时请一并核对）：
 *
 *   - `archiveMaxBytes`：**已实现**（[ADR-0048]）。`archive/store.ts` 的 `enforceLimit()`
 *     在三个触发点被调用（启动 / 每次归档落盘前 / 改上限设置时），超限时按最久未访问
 *     淘汰内容并同步删索引记录；
 *   - `cacheMaxBytes`：`capture/protocol.ts` 里是 `TODO(M3)`，当前缓存**只增不减**。
 *
 * 实现落地时把对应的值改成 `true`：徽标会消失、提示会换成"超过之后会发生什么"，
 * 输入框也会**解除禁用**（能改就说明它真的会被执行 —— 见 `views/settings.ts`）。
 * 两条分支都有单测覆盖，因此改这一个布尔值就是全部改动。
 */
export const SIZE_LIMIT_ENFORCED: Readonly<Record<SizeLimitKey, boolean>> = {
  archiveMaxBytes: true,
  cacheMaxBytes: false,
}

/** 一项上限的叙述材料（与"是否执行"无关的固定部分）。 */
interface SizeLimitFacts {
  /** 这项上限管的是什么（提示里的主语）。 */
  readonly subject: string
  /** 未实现的那个能力的名字。 */
  readonly feature: string
  /** 未实现时挂在哪个里程碑上。 */
  readonly milestone: string
  /** 超限之后实际会发生什么（只有在**已实现**时才写进提示）。 */
  readonly enforcedHint: (limit: string) => string
  /** 上限不存在（或还没实现）时，磁盘上实际会发生什么。 */
  readonly growsText: string
}

const FACTS: Readonly<Record<SizeLimitKey, SizeLimitFacts>> = {
  archiveMaxBytes: {
    subject: '归档',
    feature: '自动淘汰',
    // 这一项**已经实现**：`milestone` 与 `growsText` 只在 `enforced=false` 那条分支里出现，
    // 而生产路径永远不会给它传 false（[ADR-0048]）。留着它们是为了那条分支仍可被断言 ——
    // 也是下一项（缓存）落地前，这套叙述材料本身的样板。
    milestone: 'M2',
    // 与 `store.enforceLimit()` / `blobs.evictToFit()` 的文档一致（"按最久未访问优先淘汰"）。
    enforcedHint: (limit) => `超过 ${limit} 后按最久未访问优先淘汰。`,
    growsText: '归档不会被自动清理，会一直增长',
  },
  cacheMaxBytes: {
    subject: '缓存',
    feature: '容量控制',
    milestone: 'M3',
    // 与 `shared/constants.ts` 的 `LIMITS.cacheBytes` 注释一致（"超限先淘汰，仍不够则退化为直通"）。
    enforcedHint: (limit) =>
      `超过 ${limit} 后先淘汰最久未用的条目，仍不够时退化为直通（不写缓存，照常下载）。`,
    growsText: '缓存只增不减，会继续占用磁盘',
  },
}

export interface SizeLimitState {
  /** 这一项当前是不是"不限制"。 */
  readonly unlimited: boolean
  /**
   * 输入框里显示的值。**不限制时是空串**（由占位符说明），
   * 而不是 `0` —— 否则同一行里"输入框说 0、提示说不限制"两套说法并存。
   */
  readonly inputValue: string
  /**
   * 徽标文案；`null` 表示这一行不必加徽标。
   *
   * 只有一种情况需要它：**用户设了上限，而这个上限不会被执行**。不限制时没有"失效"可言，
   * 已实现时它照常工作 —— 两种都不该挂一个警告徽标。
   */
  readonly badge: string | null
  /** 提示正文：当前值 + 接下来会发生什么。三种状态用同一套句式。 */
  readonly hint: string
}

/** 单位换算：界面上的数字输入以 GB 计（与 `formatBytes` 的基数一致）。 */
const BYTES_PER_GB = 1024 * 1024 * 1024

/**
 * 算出一项容量上限当前的状态。
 *
 * @param key 哪一项（`archiveMaxBytes` / `cacheMaxBytes`）
 * @param bytes 当前配置值（字节）。`0`、负数、`NaN` 都按**不限制**处理 ——
 *   配置被手工改坏时，"不限制"是唯一安全的解释（它的后果是"不清理"，不是"删东西"）。
 * @param enforced 覆盖"今天是否被执行"这一事实。默认取 {@link SIZE_LIMIT_ENFORCED}；
 *   参数化只是为了让两条分支都能被单测覆盖（否则未实现的那一支永远测不到）。
 */
export function describeSizeLimit(
  key: SizeLimitKey,
  bytes: number,
  enforced: boolean = SIZE_LIMIT_ENFORCED[key],
): SizeLimitState {
  const facts = FACTS[key]
  const unlimited = !Number.isFinite(bytes) || bytes <= 0

  if (unlimited) {
    return {
      unlimited: true,
      inputValue: '',
      badge: null,
      // 不限制时不打徽标，但仍要说出"谁来清理"这个事实 —— 否则用户会以为不限制是
      // 一个可以后面再改回来的选择，而今天它其实只是"还没实现上限"的同义词。
      hint: `不限制：${facts.growsText}。${enforced ? '' : `（${facts.feature}尚未实现，计划 ${facts.milestone}）`}`,
    }
  }

  const limit = formatBytes(bytes)

  if (enforced) {
    return {
      unlimited: false,
      inputValue: toGbString(bytes),
      badge: null,
      hint: facts.enforcedHint(limit),
    }
  }

  return {
    unlimited: false,
    inputValue: toGbString(bytes),
    badge: '尚未生效',
    hint: `已设为 ${limit}，但${facts.feature}尚未实现（计划 ${facts.milestone}）：${facts.growsText}。`,
  }
}

/**
 * 字节 → 输入框里的 GB 数字。整数不留 `.0`（`2` 比 `2.0` 干净）。
 *
 * 下限是 `0.1`：小于 50 MB 的值一位小数会四舍五入成 `0`，而"0"在这个界面上恰好等于
 * **不限制** —— 那正是这一行最不该给出的暗示。显示值向上收敛到 0.1，精确值由提示里的
 * `formatBytes()` 给出（例如"已设为 1 B"）。
 */
function toGbString(bytes: number): string {
  const gb = Number((bytes / BYTES_PER_GB).toFixed(1))

  return String(Math.max(gb, 0.1))
}

/**
 * 输入框里的 GB 数字 → 字节。{@link describeSizeLimit} 的反方向。
 *
 * 空串 / `0` / 负数 / 非数字一律返回 `0`（"不限制"）—— 与 `describeSizeLimit()` 对同一个值
 * 的解释一致：用户清空输入框，意思是"不要上限"。
 *
 * 放进这个模块而不是界面里：两个方向必须在**同一个地方**成对定义，否则它们会以各自的方式
 * 漂移（改了一处基数、另一处不同步），而症状是"我设了 2 GB，它却按别的数字执行"。
 */
export function sizeLimitBytesFromInput(text: string): number {
  const value = Number(text.trim())
  if (!Number.isFinite(value) || value <= 0) return 0

  return Math.round(value * BYTES_PER_GB)
}
