/**
 * 权限拒绝日志的簿记（`src/shared/permission-log.ts`，[ADR-0085]）。
 *
 * 这里要钉住的是一对**相反**的坏法：
 *
 *   1. **刷屏** —— 内核会反复问同一件事（页面每次初始化都查一遍 `persistent-storage`），
 *      逐条记会把日志里真正有用的那几行挤掉，而那是用户唯一能自己判断"这个功能没反应是不是
 *      被我们拒了"的线索；
 *   2. **把新的证据也一起静音** —— "只记第一次"的实现若用错了键（例如只用权限名），第一次
 *      出现的"第三方页面检查"会把后来那次"上游请求"也吞掉，而后者才是我们要的证据。
 */

import { describe, expect, it } from 'vitest'

import { denialKey, trackDenial, type DenialEntry } from '../../src/shared/permission-log'

const REQUEST_FROM_UPSTREAM: DenialEntry = {
  path: 'request',
  permission: 'display-capture',
  fromUpstream: true,
}

describe('trackDenial', () => {
  it('从没记过的组合要记', () => {
    expect(trackDenial(new Set(), REQUEST_FROM_UPSTREAM)).toEqual({
      log: true,
      seen: new Set([denialKey(REQUEST_FROM_UPSTREAM)]),
    })
  })

  it('同一组不再重复（内核会反复检查同一项权限）', () => {
    const first = trackDenial(new Set(), REQUEST_FROM_UPSTREAM)

    expect(trackDenial(first.seen, REQUEST_FROM_UPSTREAM).log).toBe(false)
  })

  it('换了一项权限仍然记（那正是新证据）', () => {
    const first = trackDenial(new Set(), REQUEST_FROM_UPSTREAM)

    expect(trackDenial(first.seen, { ...REQUEST_FROM_UPSTREAM, permission: 'midi' }).log).toBe(true)
  })

  it('**检查**与**请求**是两组：第三方检查过同一项权限，不该把上游的请求静音', () => {
    // 这条是"只记第一次"这个实现的边界：键里必须带 path。
    const foreignCheck = trackDenial(new Set(), { ...REQUEST_FROM_UPSTREAM, path: 'check' })

    expect(trackDenial(foreignCheck.seen, REQUEST_FROM_UPSTREAM).log).toBe(true)
  })

  it('上游与第三方是两组：第三方先问过，不该把上游那次静音', () => {
    const foreign = trackDenial(new Set(), { ...REQUEST_FROM_UPSTREAM, fromUpstream: false })

    expect(trackDenial(foreign.seen, REQUEST_FROM_UPSTREAM).log).toBe(true)
  })
})

describe('denialKey', () => {
  it('把三个维度都编进键里（顺序稳定，因此集合可以跨调用复用）', () => {
    expect(denialKey(REQUEST_FROM_UPSTREAM)).toBe(denialKey({ ...REQUEST_FROM_UPSTREAM }))
    expect(denialKey(REQUEST_FROM_UPSTREAM)).toContain('request')
    expect(denialKey(REQUEST_FROM_UPSTREAM)).toContain('display-capture')
  })
})
