/**
 * 权限白名单的单测（[ADR-0035]）。
 *
 * 这是**安全关键**判据，而且它的失手方式很安静：放宽一项不会报错、不会有症状，只会让某个
 * 第三方页面拿到摄像头，或者在日志里少一行 `permission denied`。因此这里把三件事钉住：
 *
 *   1. 放行的**类型**恰好是那几项（多一项就要改断言 —— 而改断言需要理由）；
 *   2. **来源**必须是上游源本身，前缀骗术不算（`web.whatsapp.com@evil.com`）；
 *   3. 未知类型默认**拒绝**：上游将来申请新权限时，不该因为"我们没听说过"而放行。
 */

import { describe, expect, it } from 'vitest'

import { ALLOWED_PERMISSIONS, isPermissionAllowed } from '../../src/main/permissions'

const UPSTREAM = 'https://web.whatsapp.com/'

describe('isPermissionAllowed', () => {
  it('放行上游源的那几项权限', () => {
    for (const permission of ALLOWED_PERMISSIONS) {
      expect(isPermissionAllowed(permission, UPSTREAM)).toBe(true)
    }
  })

  it('白名单恰好是这几项（加一项就要动这里，也就必须说清理由）', () => {
    expect([...ALLOWED_PERMISSIONS].sort()).toEqual(
      [
        'clipboard-sanitized-write',
        'fullscreen',
        'media',
        'notifications',
        'persistent-storage',
      ].sort(),
    )
  })

  it('persistent-storage 放行：它不授予能力，只影响本分区数据的淘汰策略', () => {
    // 拒绝它的症状是消息历史重新同步、最坏要重新扫码（分区里是登录态与消息库）。
    expect(isPermissionAllowed('persistent-storage', UPSTREAM)).toBe(true)
  })

  it('会暴露用户东西的权限一律拒绝', () => {
    // 读剪贴板、位置、串口/USB、MIDI 之类都属于"给了就给了"的能力，而我们没有证据表明上游需要它们。
    for (const permission of [
      'clipboard-read',
      'geolocation',
      'midi',
      'midiSysex',
      'usb',
      'serial',
      'openExternal',
      'display-capture',
      'speaker-selection',
      'idle-detection',
    ]) {
      expect(isPermissionAllowed(permission, UPSTREAM)).toBe(false)
    }
  })

  it('未知类型默认拒绝', () => {
    // 上游将来引入的新权限会原样传进来；白名单的意义就是这里返回 false。
    expect(isPermissionAllowed('some-future-permission', UPSTREAM)).toBe(false)
    expect(isPermissionAllowed('', UPSTREAM)).toBe(false)
  })

  it('来源不是上游源就拒绝，哪怕权限在白名单里', () => {
    for (const origin of [
      'https://example.com/',
      // 前缀匹配的老毛病：这两个都会以"前缀是 web.whatsapp.com"的形式骗过 startsWith。
      'https://web.whatsapp.com.evil.com/',
      'https://web.whatsapp.com@evil.com/',
      // 同一个域但不同协议 / 端口，同样不是一个源。
      'http://web.whatsapp.com/',
      'https://web.whatsapp.com:8443/',
      // 空值与非法值（`requestingOrigin` 在某些检查里会是空串）。
      '',
      'not a url',
    ]) {
      expect(isPermissionAllowed('media', origin)).toBe(false)
    }
  })

  it('协议与大小写按 origin 的语义处理', () => {
    // origin 比较是大小写不敏感的（host 部分），这条钉住我们不自己做字符串处理。
    expect(isPermissionAllowed('media', 'https://WEB.WHATSAPP.COM/')).toBe(true)
  })
})
