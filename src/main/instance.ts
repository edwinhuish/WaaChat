/**
 * 当前进程是哪个实例。
 *
 * 判据在 `shared/instance.ts`（纯函数），这里只做两件它不能做的事：读 `process.argv`，
 * 以及把结果缓存起来 —— `argv` 在整个进程生命周期里不会变，而每个调用点都重新解析一遍
 * 会让"实例"这个概念有多个可能的答案。
 *
 * ⚠️ **本模块不导入 electron**（尽管名字在 `main/` 下）。`paths.ts` 要按实例分叉归档与
 * 缓存目录，而 `paths.ts` 必须保持可在没有 Electron 的环境里加载（离线自检与单测直接用它）。
 * 因此所有 `app.getPath()` / `app.setPath()` 的调用留在 `main/index.ts` 里 ——
 * 那里本来就是装配的位置。
 */

import {
  instanceLabelOf,
  instancePartition,
  isDefaultInstance,
  type InstanceArgs,
  parseInstanceArg,
} from '../shared/instance'
import { APP_DISPLAY_NAME } from '../shared/constants'

let current: InstanceArgs | null = null

/**
 * 解析并缓存本进程的实例。
 *
 * 返回的 `error` 非空时调用方**必须拒绝启动**（见 `main/index.ts`）—— 回落到默认实例会
 * 让"我指定的是 work"变成"我动的是默认实例的数据"，而这两种结果在界面上完全一样。
 */
export function resolveInstance(argv: readonly string[] = process.argv): InstanceArgs {
  current ??= parseInstanceArg(argv)
  return current
}

/** 本进程的实例标识；{@link DEFAULT_INSTANCE_ID}（空串）表示默认实例。 */
export const instanceId = (): string => resolveInstance().id

/** 本进程的会话分区名。 */
export const sessionPartition = (): string => instancePartition(instanceId())

/** 本进程在界面上（窗口标题、托盘）用来指代自己的名字。 */
export const instanceLabel = (): string => instanceLabelOf(instanceId(), APP_DISPLAY_NAME)

/**
 * 本进程是默认实例（用户没指定 `--instance`）？
 *
 * 有**三处系统集成是全机共享的、只能有一个主人**：用户级启动器条目
 * （`~/.local/share/applications/<app_id>.desktop`）、开机自启条目
 * （`~/.config/autostart/<名字>.desktop`），以及托盘图标在桌面上的那一格。
 * 前两者由默认实例维护，命名实例不去碰 —— 否则两个进程会互相覆写同一个文件，
 * 结果是"改完图标只有一半生效"这类没有报错、也说不清归属的状态。
 */
export const usingDefaultInstance = (): boolean => isDefaultInstance(instanceId())

/**
 * 给用户看的"拒绝启动"说明。
 *
 * 单独抽出来是为了让 `main/index.ts` 那几行保持"装配"的样子，而这段文字属于本模块的
 * 知识范围（它知道 `{@link INSTANCE_ARG}` 是什么）。
 */
export function describeInstanceFailure(instance: InstanceArgs): string {
  return `无法确定要启动哪个实例：${instance.error ?? '未知原因'}。请修正启动参数后重试。`
}
