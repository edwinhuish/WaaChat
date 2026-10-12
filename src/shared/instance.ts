/**
 * 实例标识（多实例隔离的**唯一**来源）。
 *
 * 一个"实例"= 一份完全独立的本地状态：一个 Chromium profile（登录态）、一份设置、
 * 一份归档、一份密文缓存。三者都挂在**同一个杠杆**上 —— `app.setPath('userData' |
 * 'sessionData')`（见 `main/instance.ts` 与 `main/index.ts` 的启动顺序）：
 *
 *   userData（`~/.config/waachat`）         → profile、分区存储、settings.json、自定义图标
 *   <XDG_DATA_HOME>/waachat/cache            → 密文缓存
 *   <Documents>/WaaChat_files                → 归档（用户可改，因此另有一条判据）
 *
 * 本文件是**纯判据**：不 import electron、不碰文件系统、不读 `process`。读 `process.argv`
 * 得到"当前是哪个实例"是 `main/instance.ts` 的事 —— 渲染进程也用不到它（界面里的实例名
 * 走 IPC，见 `shared/bridge.ts` 的 `InstanceInfo`）。这与 `size-limit.ts` /
 * `settings-sections.ts` 是同一条分工：判据留在这里，单测与离线自检都能直接断言。
 *
 * ── 向后兼容是这次改动的硬要求 ──
 *
 * **默认实例（不带 `--profile`）的目录名、分区名、界面文字一个字节都不变。** 既有用户
 * 升级之后不该看到任何差别，否则"加了个功能"会变成"我的聊天记录没了"。因此这里所有派生
 * 都遵守同一条规则：默认实例的后缀是空串。
 */

/**
 * 默认实例的标识。
 *
 * 用空串而不是 `'default'`：默认实例**就是"没有指定实例"**这一件事，而不是一个碰巧叫
 * `default` 的实例。用真实名字会带来两个后果 —— 用户可能选它（于是与不带参数启动的
 * 实例"看起来不同、实际同一个"），以及目录名要多一层判断。空串把这件事从概念上消掉。
 */
export const DEFAULT_INSTANCE_ID = ''

/**
 * 选择实例的命令行参数（`--profile work` 与 `--profile=work` 都接受）。
 *
 * 它**曾经**叫 `--instance`（v1.0.8–v1.1.1），本版本起改名为 `--profile`（[ADR-0076]）。
 * 因此旧名字不在这里 —— 它是 {@link LEGACY_INSTANCE_ARG}，见到就**拒绝启动**。
 */
export const INSTANCE_ARG = '--profile'

/**
 * 已退休的旧参数名。
 *
 * ⚠️ 对它必须**报错**，绝不能像其它陌生参数那样被无视 —— `parseInstanceArg` 的默认姿势是
 * "只认自己那两种写法，其余一律无视"（Chromium 往 `argv` 里塞了一堆自己的开关，无视是唯一
 * 可行的姿势）。于是 `waachat --instance work` 会**静默**启动默认实例：用户以为在动 work
 * 的数据，实际写的是默认实例那一份，而两者在界面上完全一样 —— 这正是本模块最不能接受的
 * 那类失败（安静地做错事）。报错文案必须说清"改成什么了"，否则用户只看到"起不来"。
 */
export const LEGACY_INSTANCE_ARG = '--instance'

/**
 * 实例名的合法形状：**小写**字母/数字开头，其后可含 `-` 与 `_`，最长 32。
 *
 * 刻意不含大写与点：
 *
 *   - 大写会被**拒绝**（而不是悄悄折成小写）—— 静默折小的后果是"用户以为建了两个实例、
 *     实际一直在往同一个目录里写"，而这件事他没法从任何界面上看出来；
 *   - 点会让 `.`、`..`、以点开头的隐藏目录变成"合法实例名"，而这里每一处派生都要拼进
 *     路径（与 `paths.ts` 里 `normalizeAccountKey()` 挡的是同一类风险）。
 */
export const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

/**
 * 保留名。
 *
 * `default` 是最容易被顺手敲出来的名字，而它**不是**默认实例（默认实例不需要参数）。
 * 不保留的话，用户会得到一个叫 `waachat-default` 的目录、里面一份空数据，同时真正的
 * 数据在 `waachat` 里 —— 这种"看起来同名、其实两处"的错位没有任何提示能补救。
 */
export const RESERVED_INSTANCE_IDS: readonly string[] = ['default']

/**
 * 归档根目录的**基名**。
 *
 * 用的是**项目名**而不是服务方的名字：这个目录是**我们创建在用户磁盘上的产物**，而它是用户
 * 唯一会在自己的文件管理器里天天看见的那一处 —— 写服务方名称容易被读成"官方目录/官方客户端
 * 生成的"。代码里出现 `web.whatsapp.com` 那类**指示性使用**不受影响，[INV-4] 也不覆盖数据
 * 目录命名；这里只是在可选的地方选更保守的一边。理由与取舍见 [ADR-0032]（它取代了
 * [ADR-0023] 关于名称的那一半）。
 *
 * 命名实例的归档根是 `<基名>-<实例名>`（见 {@link withInstanceSuffix}）。
 */
export const ARCHIVE_DIR_BASE_NAME = 'WaaChat_files'

/**
 * 会话分区名的基名。
 *
 * `persist:` 前缀是必须的 —— 没有它登录态不会持久化，每次启动都要重新扫码。
 *
 * 命名实例的分区是 `<基名>-<实例名>`。分区存储本身就在 `userData` 下，因此**即使分区名
 * 不变也已经隔离**（`userData` 一变，`persist:waachat` 就落在另一个 profile 里）；显式
 * 区分只是为了让日志、调试与"这份数据到底属于谁"一眼可见 —— 两个进程的日志里出现同一个
 * 分区名，排查时会被误读成"它们在共享登录态"。
 */
export const PARTITION_BASE = 'persist:waachat'

/** 一次参数解析的结果。 */
export interface InstanceArgs {
  /** 生效的实例标识；{@link DEFAULT_INSTANCE_ID}（空串）表示默认实例。 */
  readonly id: string
  /**
   * 用法错误的**人话**说明；非 `null` 时调用方必须**拒绝启动**。
   *
   * ⚠️ **绝不能回落成默认实例**：那会让"我指定的是 work"变成"我动的是默认实例的数据"，
   * 而两种结果在界面上完全一样 —— 是本项目最不能接受的那类失败（安静地做错事）。
   *
   * 因此名字不合法时 `{@link id}` 保留用户**原样输入**的那个值（只供日志冒烟），而不是
   * 换成一个合法的实例标识。这样即使将来某个调用方漏判了 `error`，最坏结果也只是落到一个
   * 空目录（用户看到的是"要重新扫码"），而不会写进他已经在用的那份数据 —— 两种错误里只有
   * 后者不可挽回。
   */
  readonly error: string | null
}

/** 实例名的合法性判据；返回 `null` 表示可用，否则是人话说明。 */
export function describeInstanceIdProblem(id: string): string | null {
  if (id === '') return '实例名不能为空'
  if (RESERVED_INSTANCE_IDS.includes(id)) {
    return `"${id}" 是保留名：默认实例不需要 ${INSTANCE_ARG}`
  }
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return `实例名只能由 1–32 个小写字母、数字、- 或 _ 组成，并以字母或数字开头（收到 "${id}"）`
  }

  return null
}

/**
 * 从命令行参数里解析实例。
 *
 * 只认 `--profile <名>` 与 `--profile=<名>` 两种写法，其余参数一律无视（Chromium 会往
 * `argv` 里塞它自己的开关）。同一实例被写两次且**值相同**是允许的（无害），值不同则报错：
 * 歧义不能猜，猜错的那一半是"动了另一个实例的数据"。
 *
 * 唯一的例外是 {@link LEGACY_INSTANCE_ARG}（旧名字）：它不是"被无视"，而是**报错**——见那里
 * 的说明。旧名字与 `--profile` 同时出现时，报的是旧名字那一条（它才是用户真正要改的地方）。
 *
 * 纯函数（接收 `argv` 而不是读 `process.argv`），因此每种用法都能单测。
 */
export function parseInstanceArg(argv: readonly string[]): InstanceArgs {
  const values: string[] = []
  /** 见到旧名字时记下用户**本来想要**的实例名（取不到就是空串），只为让报错文案能给出正确的改法。 */
  let legacy: string | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''

    if (arg === INSTANCE_ARG) {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('-')) {
        return {
          id: DEFAULT_INSTANCE_ID,
          error: `${INSTANCE_ARG} 后面要跟一个实例名（例如 ${INSTANCE_ARG} work）`,
        }
      }

      values.push(next)
      index += 1 // 顺手跳过刚吃掉的那个值
      continue
    }

    if (arg.startsWith(`${INSTANCE_ARG}=`)) values.push(arg.slice(INSTANCE_ARG.length + 1))

    const isLegacy = arg === LEGACY_INSTANCE_ARG || arg.startsWith(`${LEGACY_INSTANCE_ARG}=`)
    if (isLegacy) {
      const inline = arg.startsWith(`${LEGACY_INSTANCE_ARG}=`)
        ? arg.slice(LEGACY_INSTANCE_ARG.length + 1)
        : null
      const wanted = inline ?? argv[index + 1] ?? ''
      // 值像另一个开关或不存在时，只报"值没给"这一件事：改名才是要修的地方。
      legacy ??= wanted.startsWith('-') ? '' : wanted
    }
  }

  if (legacy !== null) {
    /**
     * `id` 用**用户本来想要的那个名字**（取不到就是空串），与"非法实例名保留原值"同一条理由：
     * 万一将来某个调用方漏判了 `error`，最坏也只是落到一个空目录，而不会写进用户正在用的
     * 那份数据。空串是唯一会落到默认实例的取值，而它只在用户**没写出名字**时出现。
     */
    return {
      id: legacy,
      error:
        `${LEGACY_INSTANCE_ARG} 已改名为 ${INSTANCE_ARG}，本次启动已拒绝（以免误用默认实例的数据）：` +
        `请改用 ${INSTANCE_ARG}${legacy === '' ? ' <名>' : ` ${legacy}`}`,
    }
  }

  if (values.length === 0) return { id: DEFAULT_INSTANCE_ID, error: null }

  const distinct = [...new Set(values)]
  if (distinct.length > 1) {
    return {
      id: DEFAULT_INSTANCE_ID,
      error: `实例名给了不止一个（${distinct.join('、')}），无法判断该用哪个`,
    }
  }

  const id = distinct[0] ?? DEFAULT_INSTANCE_ID
  return { id, error: describeInstanceIdProblem(id) }
}

/** 默认实例？ */
export const isDefaultInstance = (id: string): boolean => id === DEFAULT_INSTANCE_ID

/**
 * 实例后缀：默认实例是空串，其余是 `-<实例名>`。
 *
 * **所有**按实例分叉的名字都由它派生（目录名、分区名），因此"默认实例保持原样"这条
 * 兼容性要求只需要在一个地方成立，而不是在每一处各判一次。
 */
export const instanceSuffix = (id: string): string => (isDefaultInstance(id) ? '' : `-${id}`)

/**
 * 把实例后缀贴到一个应用级名字上。
 *
 * 输入是**应用目录本身**而不是它内部的某个文件：`~/.config/waachat` →
 * `~/.config/waachat-work`，`persist:waachat` → `persist:waachat-work`，
 * `WaaChat_files` → `WaaChat_files-work`。目录内部的结构（`Partitions/`、`cache/`、
 * `<账号>/<年月>/`）在两种实例下**完全一致**，于是"读哪个目录"这件事永远只有一个答案。
 */
export const withInstanceSuffix = (base: string, id: string): string =>
  `${base}${instanceSuffix(id)}`

/** 一个实例的会话分区名。 */
export const instancePartition = (id: string): string => withInstanceSuffix(PARTITION_BASE, id)

/**
 * 界面上用来指代一个实例的名字：默认实例就是应用名，其余带一个全角括号后缀。
 *
 * 用全角括号而不是 `[work]` / `- work`：它出现在**窗口标题与托盘菜单**里，要读起来像
 * "同一个应用的一个副本"，而不是像另一个程序。
 */
export const instanceLabelOf = (id: string, appName: string): string =>
  isDefaultInstance(id) ? appName : `${appName}（${id}）`

/**
 * 这个归档根目录"看起来属于另一个实例"吗？
 *
 * 判据只看**目录名**，不读文件、不落盘：命名实例的归档根必然是 `WaaChat_files-<实例名>`，
 * 因此
 *
 *   - 名叫 `WaaChat_files`（默认实例的归档根）而**我们不是**默认实例 → 是别人的；
 *   - 名叫 `WaaChat_files-<合法实例名>` 而那个名字不是我们 → 是别人的。
 *
 * 为什么不做成"拒绝"：一次拒绝意味着**放弃使用用户配置的那个目录**，而我们会退回到默认
 * 位置 —— 那个位置是空的，于是用户看到的是"我的归档不见了"。把配置指向别处是他自己的
 * 决定，我们能做的是**把后果说清楚**（启动时 warn + `docs/usage.md` 的注意事项），
 * 而不是替他把它改掉。真正保证隔离的是默认值按实例分叉（见 `paths.ts`）。
 */
export function isForeignArchiveDir(dir: string, id: string): boolean {
  const name = dir.replace(/\/+$/, '').split('/').pop() ?? ''
  if (!name.startsWith(ARCHIVE_DIR_BASE_NAME)) return false

  const suffix = name.slice(ARCHIVE_DIR_BASE_NAME.length)
  if (suffix === '') return !isDefaultInstance(id)

  if (!suffix.startsWith('-')) return false
  const owner = suffix.slice(1)

  return INSTANCE_ID_PATTERN.test(owner) && owner !== id
}
