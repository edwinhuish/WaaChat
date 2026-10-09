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
  archiveDir,
  defaultArchiveDir,
  indexDbPath,
  normalizeArchiveDir,
  setArchiveDir,
} from '../../src/main/paths'

afterEach(() => {
  // 模块级状态会跨用例残留，必须复位 —— 否则后面的用例取决于执行顺序。
  setArchiveDir('')
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
