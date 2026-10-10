/**
 * 归档位置的单测。
 *
 * 这里每一条都对应一个**会造成灾难**的输入：归档目录会被"退出时清除归档"整个清空，
 * 因此"用户手改 settings.json 写了个 `/`"必须被拦住。见 docs/decisions.md ADR-0018。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  accountKey,
  archiveAccountDir,
  archiveDir,
  archiveFilesDir,
  ciphertextCacheDir,
  defaultArchiveDir,
  indexDbPath,
  normalizeAccountKey,
  normalizeArchiveDir,
  setAccountKey,
  setArchiveDir,
} from '../../src/main/paths'

afterEach(() => {
  // 模块级状态会跨用例残留，必须复位 —— 否则后面的用例取决于执行顺序。
  setArchiveDir('')
  setAccountKey(null)
})

describe('normalizeArchiveDir', () => {
  it('接受正常的绝对路径', () => {
    expect(normalizeArchiveDir('/srv/files/chat')).toBe('/srv/files/chat')
  })

  it('去掉尾部斜杠与首尾空白', () => {
    // `/a/b/` 与 `/a/b` 是同一个目录；保留原样会让"是否等于默认位置"的比较失效。
    expect(normalizeArchiveDir('  /srv/files/  ')).toBe('/srv/files')
    expect(normalizeArchiveDir('/a/b///')).toBe('/a/b')
  })

  it('拒绝空值', () => {
    expect(normalizeArchiveDir('')).toBeNull()
    expect(normalizeArchiveDir('   ')).toBeNull()
    expect(normalizeArchiveDir(null)).toBeNull()
    expect(normalizeArchiveDir(undefined)).toBeNull()
  })

  it('拒绝相对路径（结果取决于进程的工作目录）', () => {
    expect(normalizeArchiveDir('Documents/files')).toBeNull()
    expect(normalizeArchiveDir('./files')).toBeNull()
  })

  it('拒绝过于顶层的目录', () => {
    expect(normalizeArchiveDir('/')).toBeNull()
    expect(normalizeArchiveDir('/home')).toBeNull()
    expect(normalizeArchiveDir('/opt')).toBeNull()
  })

  it('拒绝家目录本身', () => {
    expect(normalizeArchiveDir(homedir())).toBeNull()
    expect(normalizeArchiveDir(`${homedir()}/`)).toBeNull()
  })
})

describe('archiveDir', () => {
  it('默认落在文档目录下', () => {
    expect(archiveDir()).toBe(join(homedir(), 'Documents', 'WaaChat_files'))
    expect(archiveDir()).toBe(defaultArchiveDir())
  })

  it('索引跟着归档目录走（换位置时一起换）', () => {
    setArchiveDir('/srv/files/chat')

    expect(archiveDir()).toBe('/srv/files/chat')
    expect(indexDbPath()).toBe('/srv/files/chat/.index.sqlite')
  })

  it('设成空值时回到默认位置，而不是把目录变成根', () => {
    setArchiveDir('/srv/files/chat')
    setArchiveDir('')

    expect(archiveDir()).toBe(defaultArchiveDir())
  })

  it('设成非法路径时同样回到默认位置', () => {
    setArchiveDir('/')

    expect(archiveDir()).toBe(defaultArchiveDir())
  })
})

/**
 * 账号那一层（[ADR-0039]）。
 *
 * 这里挡的是"页面给的值直接当目录名用"这条路：它来自 cookie（页面写的），
 * 因此是**不可信输入** —— 与 `archive/naming.ts` 净化文件名是同一条理由。
 */
describe('normalizeAccountKey', () => {
  it('接受 UUID（今天的标识就是它），原样保留', () => {
    expect(normalizeAccountKey('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    )
  })

  it('白名单之外的一律删掉（路径分隔符、空白、控制字符）', () => {
    // `../../etc/passwd` 清完是 `....etcpasswd` —— 以点开头，于是被整条拒掉（见下一条）。
    expect(normalizeAccountKey('../../etc/passwd')).toBeNull()
    expect(normalizeAccountKey('a/b')).toBe('ab')
    expect(normalizeAccountKey('a b\tc')).toBe('abc')
    expect(normalizeAccountKey('A/B')).toBe('ab')
    expect(normalizeAccountKey('x\u0000y')).toBe('xy')
  })

  it('点开头 / 只有点 / 空值都不接受（会与归档内部条目混在一起）', () => {
    expect(normalizeAccountKey('.hidden')).toBeNull()
    expect(normalizeAccountKey('../../etc/passwd')).toBeNull()
    expect(normalizeAccountKey('..')).toBeNull()
    expect(normalizeAccountKey('.')).toBeNull()
    expect(normalizeAccountKey('')).toBeNull()
    expect(normalizeAccountKey('   ')).toBeNull()
    expect(normalizeAccountKey(null)).toBeNull()
  })

  it('纯数字也接受（将来若把手机号当标识，不必再改这里）', () => {
    expect(normalizeAccountKey('18665597400')).toBe('18665597400')
  })

  it('超长截断（目录名不该被一个荒唐的 cookie 撑爆）', () => {
    expect(normalizeAccountKey('a'.repeat(200))).toHaveLength(72)
  })
})

describe('accountKey', () => {
  it('没设置时回落到 unknown-account（那是正常状态，不是错误）', () => {
    expect(accountKey()).toBe('unknown-account')
  })

  it('设了就用它，并且归档与缓存两棵树都跟着走', () => {
    setArchiveDir('/srv/files')
    setAccountKey('a1b2c3d4-e5f6-7890-abcd-ef1234567890')

    expect(accountKey()).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890')
    expect(archiveAccountDir()).toBe('/srv/files/a1b2c3d4-e5f6-7890-abcd-ef1234567890')
    expect(archiveFilesDir()).toBe('/srv/files/a1b2c3d4-e5f6-7890-abcd-ef1234567890/files')
    // 密文缓存的**根**不随归档位置移动（ADR-0008），但那一层账号目录要跟上。
    expect(ciphertextCacheDir().endsWith('/cache')).toBe(true)
    expect(accountKey()).not.toBe('')
  })

  it('设成不可用的值时回到回落值，而不是让目录名变成空串', () => {
    setAccountKey('a1b2c3d4-e5f6-7890-abcd-ef1234567890')
    expect(setAccountKey('.')).toBe('unknown-account')
    expect(archiveFilesDir().endsWith('/unknown-account/files')).toBe(true)
  })
})
