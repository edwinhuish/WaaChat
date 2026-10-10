/**
 * 容量上限那一行的状态（`shared/size-limit.ts`）。
 *
 * 这一层要挡住的是"状态提示与实际配置不符"这一类错误，它有两个方向，都很难被发现：
 *
 *   1. **配置是不限制，却标着"尚未生效"** —— 用户会去找一个并不存在的问题
 *      （默认配置就是这一档：`archiveMaxBytes` 默认 0）；
 *   2. **功能落地之后徽标还在** —— 没人会想起来删那句话，于是提示开始撒谎。
 *
 * 因此这里把两种"是否已实现"都断言一遍：今天走的是未实现那一支，而实现落地时改的是
 * `SIZE_LIMIT_ENFORCED` 里的一个布尔值，另一支必须立刻是对的。
 */

import { describe, expect, it } from 'vitest'

import { SIZE_LIMIT_ENFORCED, describeSizeLimit } from '../../src/shared/size-limit'

const GB = 1024 * 1024 * 1024

describe('describeSizeLimit（归档）', () => {
  it('不限制时：不打"尚未生效"徽标，也不假装有个上限', () => {
    const state = describeSizeLimit('archiveMaxBytes', 0, false)

    // 徽标是"你设的上限不会被执行"的警告；不限制时这句话没有对象。
    expect(state.badge).toBeNull()
    expect(state.unlimited).toBe(true)
    // 输入框留空（由占位符说"不限制"），而不是显示 0 —— 否则同一行有两套说法。
    expect(state.inputValue).toBe('')
    expect(state.hint).toContain('不限制')
    expect(state.hint).toContain('归档不会被自动清理')
    // 仍要说清"为什么现在没法限制它"。
    expect(state.hint).toContain('自动淘汰尚未实现')
    expect(state.hint).toContain('M2')
  })

  it('设了上限但淘汰还没实现时：徽标 + 后果 + 当前值，缺一不可', () => {
    const state = describeSizeLimit('archiveMaxBytes', 50 * GB, false)

    expect(state.badge).toBe('尚未生效')
    expect(state.unlimited).toBe(false)
    expect(state.inputValue).toBe('50')
    expect(state.hint).toContain('已设为 50 GB')
    expect(state.hint).toContain('自动淘汰尚未实现')
    // 关键：说清**实际后果**（不清理、继续增长），而不是只说"不生效"。
    expect(state.hint).toContain('会一直增长')
  })

  it('淘汰实现之后：徽标消失，提示换成"超过之后会发生什么"', () => {
    const state = describeSizeLimit('archiveMaxBytes', 50 * GB, true)

    expect(state.badge).toBeNull()
    expect(state.inputValue).toBe('50')
    expect(state.hint).toContain('超过 50 GB')
    expect(state.hint).toContain('最久未访问优先淘汰')
    expect(state.hint).not.toContain('尚未实现')
  })

  it('不限制 + 已实现：仍然说清"不会自动清理"，但不提里程碑', () => {
    const state = describeSizeLimit('archiveMaxBytes', 0, true)

    expect(state.badge).toBeNull()
    expect(state.hint).toContain('不限制')
    expect(state.hint).not.toContain('尚未实现')
  })
})

describe('describeSizeLimit（密文缓存）', () => {
  it('设了上限时用缓存自己的措辞（只增不减而不是被清理）', () => {
    const state = describeSizeLimit('cacheMaxBytes', 2 * GB, false)

    expect(state.badge).toBe('尚未生效')
    expect(state.inputValue).toBe('2')
    expect(state.hint).toContain('已设为 2.0 GB')
    expect(state.hint).toContain('容量控制尚未实现')
    expect(state.hint).toContain('M3')
    expect(state.hint).toContain('只增不减')
  })

  it('实现之后提示里带上"退化为直通"这条约定', () => {
    const state = describeSizeLimit('cacheMaxBytes', 2 * GB, true)

    expect(state.badge).toBeNull()
    expect(state.hint).toContain('退化为直通')
  })
})

describe('describeSizeLimit（值的处理）', () => {
  it('今天是"未实现"这一档（改这里必须同时改界面文案的断言）', () => {
    // 断言事实而不是断言宣传：这两项落地时，这条用例会红，提醒把 `SIZE_LIMIT_ENFORCED`
    // 与 docs/usage.md 一起改掉。
    expect(SIZE_LIMIT_ENFORCED.archiveMaxBytes).toBe(false)
    expect(SIZE_LIMIT_ENFORCED.cacheMaxBytes).toBe(false)
  })

  it('负数 / NaN 一律按不限制处理（配置被改坏时，唯一安全的解释是不清理）', () => {
    for (const broken of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const state = describeSizeLimit('archiveMaxBytes', broken, false)

      expect(state.unlimited).toBe(true)
      expect(state.badge).toBeNull()
      expect(state.inputValue).toBe('')
    }
  })

  it('小数按一位小数显示，并去掉多余的 .0', () => {
    expect(describeSizeLimit('cacheMaxBytes', 1.5 * GB, false).inputValue).toBe('1.5')
    expect(describeSizeLimit('cacheMaxBytes', 512 * 1024 * 1024, false).inputValue).toBe('0.5')
    expect(describeSizeLimit('cacheMaxBytes', 1024 * 1024 * 1024, false).inputValue).toBe('1')
  })

  it('小于 0.05 GB 的值不会显示成 0（0 在这个界面上等于"不限制"）', () => {
    const state = describeSizeLimit('archiveMaxBytes', 1, false)

    expect(state.unlimited).toBe(false)
    expect(state.inputValue).not.toBe('0')
    // 精确值仍然出现在提示里。
    expect(state.hint).toContain('1 B')
  })
})
