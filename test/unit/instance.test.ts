/**
 * 实例标识的单测（`src/shared/instance.ts`）。
 *
 * 这里断言的三类东西，恰好就是多实例隔离**唯一**可能悄悄坏掉的三个地方：
 *
 *   1. **向后兼容**：默认实例派生出来的名字必须与改动之前一模一样（否则升级 = 数据"消失"）；
 *   2. **两两不等**：不同实例派生出来的目录名/分区名必须互不相同（否则"隔离"只是说法）；
 *   3. **非法参数要拒绝**，绝不能回落到默认实例（否则"我指定了 work"变成"我动了默认实例
 *      的数据"，而两种结果在界面上完全一样）。
 */

import { describe, expect, it } from 'vitest'

import {
  ARCHIVE_DIR_BASE_NAME,
  DEFAULT_INSTANCE_ID,
  INSTANCE_ARG,
  instanceLabelOf,
  instancePartition,
  instanceSuffix,
  isDefaultInstance,
  isForeignArchiveDir,
  parseInstanceArg,
  describeInstanceIdProblem,
  withInstanceSuffix,
} from '../../src/shared/instance'

const APP = 'WaaChat'

describe('parseInstanceArg', () => {
  it('没有参数就是默认实例', () => {
    for (const argv of [[], ['/usr/bin/waachat'], ['--debug'], ['--instance' + 'X']]) {
      expect(parseInstanceArg(argv)).toEqual({ id: DEFAULT_INSTANCE_ID, error: null })
    }
  })

  it('两种写法都认', () => {
    expect(parseInstanceArg(['waachat', INSTANCE_ARG, 'work'])).toEqual({ id: 'work', error: null })
    expect(parseInstanceArg(['waachat', `${INSTANCE_ARG}=work`])).toEqual({
      id: 'work',
      error: null,
    })
  })

  it('无视与它无关的参数（Chromium 会往 argv 里塞自己的开关）', () => {
    const argv = [
      'waachat',
      '--enable-features=Foo',
      INSTANCE_ARG,
      'work',
      '--ozone-platform=wayland',
    ]

    expect(parseInstanceArg(argv)).toEqual({ id: 'work', error: null })
  })

  it('值相同地写两次是允许的（无害），不同则报错', () => {
    expect(parseInstanceArg([INSTANCE_ARG, 'work', INSTANCE_ARG, 'work']).error).toBeNull()
    expect(parseInstanceArg([INSTANCE_ARG, 'work', INSTANCE_ARG, 'home']).error).not.toBeNull()
  })

  it('缺值 / 值像另一个开关 / 空值都报错，而不是当成"没指定"', () => {
    // ⚠️ 这一条是本次改动最要紧的一处：报错意味着**拒绝启动**。
    // 若这些输入被当成"没指定"，用户以为在动 work 实例，实际动的是默认实例的数据。
    for (const argv of [
      [INSTANCE_ARG],
      [INSTANCE_ARG, '--debug'],
      // 以 `-` 开头的值一律当成"另一个开关"，因此 `-leading` 落到这一支（它同时也**不是**一个
      // 合法实例名）。归到哪一支不重要：两种都是"报错并且拒绝启动"。
      [INSTANCE_ARG, '-leading'],
      [`${INSTANCE_ARG}=`],
      [INSTANCE_ARG, ''],
    ]) {
      const parsed = parseInstanceArg(argv)
      expect(parsed.error).not.toBeNull()
      expect(parsed.id).toBe(DEFAULT_INSTANCE_ID)
    }
  })

  it('非法名字一律报错，并且**不**悄悄折成合法的（大写就是大写）', () => {
    for (const bad of [
      'Work',
      'WORK',
      'work.instance',
      '.hidden',
      '_leading',
      'a'.repeat(33),
      '工作',
    ]) {
      const parsed = parseInstanceArg([INSTANCE_ARG, bad])

      expect(parsed.error).not.toBeNull()
      // 报错时**保留原值**，而不是"折成合法"或"回落到默认"：漏判 error 的调用方最多落到一个
      // 空目录（用户看到的是"要重新扫码"），不会写进他正在用的那份数据。
      expect(parsed.id).toBe(bad)
      expect(isDefaultInstance(parsed.id)).toBe(false)
    }
  })

  it('保留名 default 被拒绝 —— 它不是默认实例，且最容易被顺手敲出来', () => {
    const parsed = parseInstanceArg([INSTANCE_ARG, 'default'])
    expect(parsed.error).not.toBeNull()
    // 保留名的后果说明要提到"默认实例不需要这个参数"，否则用户不知道正确写法。
    expect(parsed.error).toContain('默认实例')
  })
})

describe('describeInstanceIdProblem', () => {
  it('合法名字返回 null', () => {
    for (const good of ['work', 'a', 'b2', 'my-work', 'my_work', 'a'.repeat(32)]) {
      expect(describeInstanceIdProblem(good)).toBeNull()
    }
  })

  it('每个拒绝理由都是人话（含收到的那个值）', () => {
    expect(describeInstanceIdProblem('')).toContain('不能为空')
    expect(describeInstanceIdProblem('default')).toContain('保留名')
    expect(describeInstanceIdProblem('Work')).toContain('Work')
  })
})

describe('名字派生', () => {
  it('默认实例的后缀是空串 —— 这一条是整个向后兼容的地基', () => {
    expect(isDefaultInstance(DEFAULT_INSTANCE_ID)).toBe(true)
    expect(instanceSuffix(DEFAULT_INSTANCE_ID)).toBe('')
    expect(withInstanceSuffix('anything', DEFAULT_INSTANCE_ID)).toBe('anything')
  })

  it('默认实例派生出的名字与改动之前**逐字符**相同', () => {
    // 这些是写死在旧代码里的值（constants.ts 与 paths.ts）。它们变了，既有用户的数据就
    // 找不到自己了 —— 因此这条断言不是"描述现状"，而是本次改动的验收条件。
    expect(instancePartition(DEFAULT_INSTANCE_ID)).toBe('persist:waachat')
    expect(withInstanceSuffix('WaaChat_files', DEFAULT_INSTANCE_ID)).toBe('WaaChat_files')
    expect(withInstanceSuffix('waachat', DEFAULT_INSTANCE_ID)).toBe('waachat')
  })

  it('命名实例只是在应用级名字后面接一个后缀，内部结构不动', () => {
    expect(instanceSuffix('work')).toBe('-work')
    expect(instancePartition('work')).toBe('persist:waachat-work')
    expect(withInstanceSuffix(ARCHIVE_DIR_BASE_NAME, 'work')).toBe('WaaChat_files-work')
    expect(withInstanceSuffix('/home/u/.config/waachat', 'work')).toBe(
      '/home/u/.config/waachat-work',
    )
  })

  it('不同实例派生出的分区名两两不同（默认实例也算一个）', () => {
    const ids = [DEFAULT_INSTANCE_ID, 'work', 'home', 'work2', 'a-b', 'a_b']
    const partitions = ids.map(instancePartition)
    const archives = ids.map((id) => withInstanceSuffix(ARCHIVE_DIR_BASE_NAME, id))

    expect(new Set(partitions).size).toBe(ids.length)
    expect(new Set(archives).size).toBe(ids.length)
  })

  it('界面上的名字：默认实例就是应用名，命名实例带全角括号后缀', () => {
    expect(instanceLabelOf(DEFAULT_INSTANCE_ID, APP)).toBe(APP)
    expect(instanceLabelOf('work', APP)).toBe(`${APP}（work）`)
  })
})

describe('isForeignArchiveDir', () => {
  it('默认实例用默认名字不算"别人的"', () => {
    expect(isForeignArchiveDir('/home/u/Documents/WaaChat_files', DEFAULT_INSTANCE_ID)).toBe(false)
    // 末尾斜杠是同一个目录，不能因为写法不同就换个结论。
    expect(isForeignArchiveDir('/home/u/Documents/WaaChat_files/', DEFAULT_INSTANCE_ID)).toBe(false)
  })

  it('命名实例指着默认实例的归档 = 别人的', () => {
    expect(isForeignArchiveDir('/home/u/Documents/WaaChat_files', 'work')).toBe(true)
  })

  it('指着另一个命名实例的归档 = 别人的；指着自己的 = 自己的', () => {
    expect(isForeignArchiveDir('/home/u/Documents/WaaChat_files-home', 'work')).toBe(true)
    expect(isForeignArchiveDir('/home/u/Documents/WaaChat_files-work', 'work')).toBe(false)
  })

  it('默认实例指着某个命名实例的归档 = 别人的', () => {
    expect(isForeignArchiveDir('/home/u/Documents/WaaChat_files-work', DEFAULT_INSTANCE_ID)).toBe(
      true,
    )
  })

  it('名字不像我们的归档根时不管（用户的普通目录不该被认领）', () => {
    for (const dir of [
      '/srv/files',
      '/home/u/Documents/files',
      '/home/u/Documents/WaaChat_filesX',
      // 后缀不是合法的实例名（实例名只能是小写 ASCII）：那是用户自己起的名，不是实例。
      '/home/u/Documents/WaaChat_files-备份',
      '/home/u/Documents/WaaChat_files-我的',
    ]) {
      expect(isForeignArchiveDir(dir, 'work')).toBe(false)
    }
  })

  it('后缀是合法实例名形状时才认（Work 不是合法实例名，因此不是实例的目录）', () => {
    expect(isForeignArchiveDir('/home/u/Documents/WaaChat_files-Work', 'work')).toBe(false)
    expect(isForeignArchiveDir('/home/u/Documents/WaaChat_files-other', 'work')).toBe(true)
  })
})
