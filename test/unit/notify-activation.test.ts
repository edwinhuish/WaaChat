/**
 * 认领"页面通知被点了"的判据（`src/shared/notify-activation.ts`，[ADR-0096]）。
 *
 * 这里测的全部是**会安静坏掉**的情形：认领错了会让聊天窗口无缘无故跳出来，漏认领则是
 * "点了没反应"（与没做这个功能一样）。而这两者在日志里都不会留下任何痕迹。
 *
 * 最要紧的是那个**竞态**：`Notify` 的回复可能比 `GetConnectionCredentials` 先到，
 * 那时 serial 还没进 `pendingSerials` —— 若把先到的回复丢掉，症状是"第一次点击不生效、
 * 之后才正常"，几乎无法复现。
 */

import { describe, expect, it } from 'vitest'

import {
  CLAIM_LIMIT,
  EMPTY_CLAIM,
  RECENT_RETURN_LIMIT,
  claimNotificationId,
  claimOwnNotify,
  decideClick,
  releaseClosed,
  type ClaimState,
} from '../../src/shared/notify-activation'

const OUR_CONNECTION = ':1.1038'
const SOMEONE_ELSE = ':1.900'

describe('claimOwnNotify / claimNotificationId', () => {
  it('serial 与回复按顺序到达时，id 进册子', () => {
    let state = claimOwnNotify(EMPTY_CLAIM, { sender: OUR_CONNECTION, serial: 64 })
    expect(state.pendingSerials).toEqual([64])
    expect(state.ownSenders).toEqual([OUR_CONNECTION])

    state = claimNotificationId(state, { replySerial: 64, notificationId: 123 })
    expect(state.pendingSerials).toEqual([])
    expect(state.ownIds).toEqual([123])
  })

  it('回复先于 PID 核实到达时，仍能认领（那个竞态）', () => {
    // 回复先到：还没有任何 pending serial，进缓冲。
    let state = claimNotificationId(EMPTY_CLAIM, { replySerial: 64, notificationId: 123 })
    expect(state.ownIds).toEqual([])
    expect(state.recentReturns).toEqual([{ replySerial: 64, notificationId: 123 }])

    // 核实随后成立：从缓冲里认领，缓冲清掉。
    state = claimOwnNotify(state, { sender: OUR_CONNECTION, serial: 64 })
    expect(state.ownIds).toEqual([123])
    expect(state.pendingSerials).toEqual([])
    expect(state.recentReturns).toEqual([])
  })

  it('别人的回复留在缓冲里，不会被当成我们的 id', () => {
    const state = claimNotificationId(EMPTY_CLAIM, { replySerial: 7, notificationId: 999 })
    expect(state.ownIds).toEqual([])
    expect(decideClick(state, { notificationId: 999, destination: null }).activate).toBe(false)
  })

  it('缓冲有上限（只覆盖那个毫秒级窗口，不攒别人的回复）', () => {
    let state: ClaimState = EMPTY_CLAIM
    for (let i = 0; i < RECENT_RETURN_LIMIT + 5; i += 1) {
      state = claimNotificationId(state, { replySerial: i, notificationId: 1000 + i })
    }
    expect(state.recentReturns).toHaveLength(RECENT_RETURN_LIMIT)
    expect(state.recentReturns.at(-1)).toEqual({
      replySerial: RECENT_RETURN_LIMIT + 4,
      notificationId: 1000 + RECENT_RETURN_LIMIT + 4,
    })
  })

  it('册子里的 id 有上限', () => {
    let state: ClaimState = EMPTY_CLAIM
    for (let i = 0; i < CLAIM_LIMIT + 3; i += 1) {
      state = claimOwnNotify(state, { sender: OUR_CONNECTION, serial: i })
      state = claimNotificationId(state, { replySerial: i, notificationId: i })
    }
    expect(state.ownIds).toHaveLength(CLAIM_LIMIT)
  })
})

describe('decideClick', () => {
  it('按 id 认领：命中即激活，并把它移出册子（点第二次不会再激活）', () => {
    let state = claimOwnNotify(EMPTY_CLAIM, { sender: OUR_CONNECTION, serial: 64 })
    state = claimNotificationId(state, { replySerial: 64, notificationId: 123 })

    const first = decideClick(state, { notificationId: 123, destination: null })
    expect(first.activate).toBe(true)

    const second = decideClick(first.state, { notificationId: 123, destination: null })
    expect(second.activate).toBe(false)
  })

  it('按连接认领：destination 是我们自己那条 libnotify 连接', () => {
    const state = claimOwnNotify(EMPTY_CLAIM, { sender: OUR_CONNECTION, serial: 64 })
    const decision = decideClick(state, {
      notificationId: 456,
      destination: OUR_CONNECTION,
    })
    expect(decision.activate).toBe(true)
  })

  it('别人的通知、广播形态都认不下来', () => {
    const state = claimOwnNotify(EMPTY_CLAIM, { sender: OUR_CONNECTION, serial: 64 })

    expect(decideClick(state, { notificationId: 456, destination: SOMEONE_ELSE }).activate).toBe(
      false,
    )
    expect(decideClick(state, { notificationId: 456, destination: null }).activate).toBe(false)
  })
})

describe('releaseClosed', () => {
  it('通知关掉之后那个 id 不再认领', () => {
    let state = claimOwnNotify(EMPTY_CLAIM, { sender: OUR_CONNECTION, serial: 64 })
    state = claimNotificationId(state, { replySerial: 64, notificationId: 123 })
    state = releaseClosed(state, 123)

    expect(state.ownIds).toEqual([])
    expect(decideClick(state, { notificationId: 123, destination: null }).activate).toBe(false)
  })

  it('不认识 id 时原样返回（不做无意义的拷贝）', () => {
    const state = claimOwnNotify(EMPTY_CLAIM, { sender: OUR_CONNECTION, serial: 64 })
    expect(releaseClosed(state, 123)).toBe(state)
  })
})
