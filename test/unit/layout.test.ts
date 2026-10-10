/**
 * 归档分层的单测（[ADR-0037] / [ADR-0039] / [ADR-0052] / [ADR-0055]）。
 *
 * 这一层是**纯函数**，所以每条断言都直接对应一个具体的坏结果：
 *
 *   1. **会话ID 不净化**（页面给的值直接当目录名）→ 路径穿越点，或一个含 `/`、控制字符的
 *      怪目录名；
 *   2. **相对路径不净化** → `join(归档目录, stored_name)` 变成路径穿越点；
 *   3. **容器判据放太宽**（把用户自己的 `stuff/` 也认成账号目录 / 会话目录）→ 迁移会把不
 *      属于我们的目录当成正文搬走；放太紧则会让**自己写下的**目录被判成异常、迁移直接失败
 *      —— [ADR-0052] 时期的消息ID 目录就是这种"放太紧就会被判成异常"的旧数据。
 *
 * 月份相关的断言保留着（[ADR-0037] / [ADR-0039]）：写入侧已不再产生月份目录（[ADR-0052]
 * 换成了消息/会话），但**密文缓存仍在用 `folderFor()`**，而旧数据必须继续被迁移认出来。
 */

import { describe, expect, it } from 'vitest'

import {
  ACCOUNT_FALLBACK,
  CHAT_FALLBACK,
  archiveStoredPath,
  folderFor,
  isAccountSegment,
  isArchiveMonthDir,
  isChatSegment,
  isLegacyMonthDir,
  isLegacyYearDir,
  normalizeChatId,
  normalizeStoredPath,
} from '../../src/main/archive/layout'

const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
/** 会话ID：页面上的会话 JID（个人会话 / 群会话 / LID 三种形态都出现过）。 */
const CHAT = '18665597400@c.us'
/** [ADR-0052] 时期的第二级：消息ID。老归档里全是这种目录，迁移必须照样认。 */
const LEGACY_MESSAGE = '3EB0A1B2C3D4E5F6A7B8'

describe('folderFor', () => {
  it('按本地时间给出单层的 年-月', () => {
    // 本地时间正午，避开时区与夏令时把日期推过边界的可能。
    expect(folderFor(new Date(2026, 9, 5, 12).getTime())).toBe('2026-10')
  })

  it('月份从 1 开始算，而不是 Date 的 0', () => {
    expect(folderFor(new Date(2026, 0, 31, 12).getTime())).toBe('2026-01')
    expect(folderFor(new Date(2026, 11, 31, 12).getTime())).toBe('2026-12')
  })

  it('个位月份补零（否则目录名的字典序与时间序不一致）', () => {
    expect(folderFor(new Date(2026, 2, 1, 12).getTime())).toBe('2026-03')
  })

  it('非有限时间戳直接抛（否则会建出一个 NaN-NaN 目录）', () => {
    expect(() => folderFor(Number.NaN)).toThrow(TypeError)
    expect(() => folderFor(Number.POSITIVE_INFINITY)).toThrow(TypeError)
  })
})

describe('容器判据', () => {
  it('月份目录必须是 年-月，且月份在 01–12', () => {
    expect(isArchiveMonthDir('2026-10')).toBe(true)
    expect(isArchiveMonthDir('2026-01')).toBe(true)
    expect(isArchiveMonthDir('2026-00')).toBe(false)
    expect(isArchiveMonthDir('2026-13')).toBe(false)
    expect(isArchiveMonthDir('2026-1')).toBe(false)
    expect(isArchiveMonthDir('2026')).toBe(false)
    // ADR-0037 当时的两层形态**不算**月份目录：它是另一条判据（isLegacy*）。
    expect(isArchiveMonthDir('2026/10')).toBe(false)
  })

  it('ADR-0037 的旧两层仍然认（否则老数据迁移不了）', () => {
    expect(isLegacyYearDir('2026')).toBe(true)
    expect(isLegacyYearDir('26')).toBe(false)
    expect(isLegacyMonthDir('10')).toBe(true)
    expect(isLegacyMonthDir('13')).toBe(false)
    expect(isLegacyMonthDir('1')).toBe(false)
  })

  it('账号目录只认 UUID 形状、unknown-account 与当前生效的那个名字', () => {
    expect(isAccountSegment(UUID, UUID)).toBe(true)
    expect(isAccountSegment('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'other')).toBe(true)
    expect(isAccountSegment(ACCOUNT_FALLBACK, UUID)).toBe(true)
    expect(isAccountSegment('18665597400', '18665597400')).toBe(true)
  })

  it('别的东西不是账号目录（迁移必须因此失败，而不是搬走用户的目录）', () => {
    expect(isAccountSegment('stuff', UUID)).toBe(false)
    expect(isAccountSegment('2026-10', UUID)).toBe(false)
    expect(isAccountSegment('.open', UUID)).toBe(false)
    expect(isAccountSegment('a1b2c3d4e5f67890abcdef1234567890', UUID)).toBe(false)
  })

  it('会话目录要"已是合法段 + 足够长"，短名 / 非我段一律不算', () => {
    expect(isChatSegment(CHAT)).toBe(true)
    expect(isChatSegment('120363012345678901@g.us')).toBe(true)
    expect(isChatSegment('123456789012345@lid')).toBe(true)
    expect(isChatSegment(CHAT_FALLBACK)).toBe(true)
    // [ADR-0052] 的消息ID 目录必须继续算 —— 老归档还在磁盘上，认不出就迁移不了。
    expect(isChatSegment(LEGACY_MESSAGE)).toBe(true)
    expect(isChatSegment('unknown-message')).toBe(true)
    // 短名（含我们自己那个 `files` 段）不算：它是账号层的旧布局容器，不是会话目录。
    expect(isChatSegment('files')).toBe(false)
    expect(isChatSegment('stuff')).toBe(false)
    // 月份名长度不够，也不会被当成会话目录。
    expect(isChatSegment('2026-10')).toBe(false)
    // 含需净化的字符 ⇒ 与 normalizeChatId 的结果不同 ⇒ 不算。
    expect(isChatSegment('18665597400/@c.us')).toBe(false)
  })
})

describe('normalizeChatId', () => {
  it('保留大小写与 `@`，只去掉白名单之外的字符', () => {
    // `@` 必须留下：它就是会话标识的一部分，抹掉之后目录名再也对不上会话。
    expect(normalizeChatId(CHAT)).toBe(CHAT)
    expect(normalizeChatId('120363012345678901@g.us')).toBe('120363012345678901@g.us')
    expect(normalizeChatId('3EB0-A1B2_C3')).toBe('3EB0-A1B2_C3')
    expect(normalizeChatId('a/b\\c')).toBe('abc')
    expect(normalizeChatId(`  ${CHAT}  `)).toBe(CHAT)
  })

  it('清不干净的整条拒掉（与账号名同一条纪律）', () => {
    expect(normalizeChatId('../../etc/passwd')).toBe(null)
    expect(normalizeChatId('.hidden')).toBe(null)
    expect(normalizeChatId('..')).toBe(null)
    expect(normalizeChatId('   ')).toBe(null)
    expect(normalizeChatId(undefined)).toBe(null)
    expect(normalizeChatId(null)).toBe(null)
  })

  it('超长截断（不留一个会撞上路径长度限制的名字）', () => {
    expect(normalizeChatId('a'.repeat(200))).toHaveLength(128)
  })
})

describe('archiveStoredPath', () => {
  it('把账号、会话ID、files 与文件名拼成写进索引的相对路径', () => {
    expect(archiveStoredPath(UUID, CHAT, '合同.pdf')).toBe(`${UUID}/${CHAT}/files/合同.pdf`)
  })

  it('拿不到账号时用 unknown-account（那是个正常状态，不是错误）', () => {
    expect(archiveStoredPath(ACCOUNT_FALLBACK, CHAT, '合同.pdf')).toBe(
      `unknown-account/${CHAT}/files/合同.pdf`,
    )
  })

  it('拿不到会话ID时用 unknown-chat（与账号回落对称）', () => {
    expect(archiveStoredPath(UUID, CHAT_FALLBACK, '合同.pdf')).toBe(
      `${UUID}/unknown-chat/files/合同.pdf`,
    )
  })
})

describe('normalizeStoredPath', () => {
  it('剥掉路径穿越（`..` 与多余的分隔符都不会越出归档目录）', () => {
    expect(normalizeStoredPath('../../etc/passwd')).toBe('etc/passwd')
    expect(normalizeStoredPath('/etc/passwd')).toBe('etc/passwd')
    expect(normalizeStoredPath('2026/../../etc/passwd')).toBe('2026/etc/passwd')
  })

  it('去掉空段与 `.`（用户手改索引后的容错）', () => {
    expect(normalizeStoredPath('a1b2/3EB0A1B2/files//报告.pdf')).toBe(
      'a1b2/3EB0A1B2/files/报告.pdf',
    )
    expect(normalizeStoredPath('./a1b2/files/2026-10/报告.pdf')).toBe('a1b2/files/2026-10/报告.pdf')
  })

  it('什么都剩不下时返回空串（调用方据此选用一个不可能存在的路径）', () => {
    expect(normalizeStoredPath('')).toBe('')
    expect(normalizeStoredPath('..')).toBe('')
    expect(normalizeStoredPath('../')).toBe('')
  })

  it('历史形态都原样保留（位置是事实，不反推）', () => {
    expect(normalizeStoredPath('2026/10/旧两层的文件.pdf')).toBe('2026/10/旧两层的文件.pdf')
    expect(normalizeStoredPath('a1b2c3d4.pdf')).toBe('a1b2c3d4.pdf')
    expect(normalizeStoredPath('a1b2/files/2026-10/合同.pdf')).toBe('a1b2/files/2026-10/合同.pdf')
  })
})
