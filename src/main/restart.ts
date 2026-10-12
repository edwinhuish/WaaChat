/**
 * 「立即重启」—— 让"重启后生效"的那些设置不必让用户自己去关再开。
 *
 * ── 为什么值得有一个函数 ────────────────────────────────────────────────────
 *
 * 这一件事有三处**顺序**上的要求，任何一处错位都**不报错**、只会让"重启"变成"退出"或者
 * "半截退出"：
 *
 *   1. **`app.relaunch()` 必须在 `app.quit()` 之前。** Electron 的文档写着 `relaunch()`
 *      自己不退出应用，要调用方接着退 —— 反过来的顺序下，进程已经不在了，那一次 relaunch
 *      落在空处，症状是**点了重启、应用没了**。
 *   2. **必须走 `app.quit()`，不能用 `app.exit()`。** `exit()` 直接结束进程，`before-quit` /
 *      `will-quit` 全都不发 —— 于是 `wipeArchiveOnExit`（用户明确要求"退出时清除归档"）与
 *      `closeArchiveStore()`（SQLite 的收尾）一起被跳过。前者是隐私承诺，后者会留下未合并的
 *      WAL。这条与托盘「退出」走的是**同一条**路径，不是另开一条。
 *   3. **不能自己起新进程。** `relaunch()` 会沿用当前 argv（默认 `process.argv.slice(1)`），
 *      因此 `--profile work` 这样的实例参数会被带过去；手写 `spawn` 就得自己复制一遍这层
 *      语义，而漏掉它的后果是"重启之后进了另一个实例"。
 *
 * ── 单实例锁会不会撞车（实测，Electron 44.7.0）──────────────────────────────
 *
 * 这是这条路唯一真正的风险：新进程若在旧进程释放锁**之前**起来，它会认为"已经有一个实例
 * 在跑"（`main/index.ts` 的 `requestSingleInstanceLock`）然后**直接退出** —— 用户看到的就是
 * "点一下重启，应用没了"。
 *
 * 用三代进程的探针实测（`before-quit` 里**故意阻塞 4 秒**，模拟"退出时清上千个归档文件"）：
 *
 * ```
 * 37.022  gen1 calling app.relaunch() -> gen2
 * 41.098  gen1 slow cleanup finished      ← 旧进程收尾花了 4 秒
 * 41.446  gen2 LOCK-OK                    ← 新进程在旧进程退出之后才拿到锁
 * ```
 *
 * 也就是说 `relaunch()` 是**等当前实例退出之后**才起新进程的，慢收尾不会造成抢锁失败。
 * 因此这里不需要"重试抢锁"或"绕过锁"那类 workaround —— **不要**加，加了反而会把
 * "同一实例只有一个进程"这条保证拆掉（[ADR-0062]）。
 */

import { app } from 'electron'

import { logger } from './logger'

/**
 * 已经发起过重启。
 *
 * 挡住"用户连点两下按钮"：`relaunch()` 调两次会起**两个**新实例，而其中第二个会撞上单实例锁
 * 退掉 —— 表面看没事，实际多起过一整个进程（还要经历一次登录态分区的抢占）。
 */
let relaunching = false

/**
 * 重启应用。调用之后本进程会退出，因此它**是这条路径的最后一步**。
 *
 * 同步返回，返回之后调用方应当什么都不做 —— 尤其不要再往界面回消息：`app.quit()` 之后
 * 渲染进程正在关闭，回包落在空处（[ADR-0059] 那类"持有的是已经没了的东西"是同一个坑）。
 */
export function relaunchApp(): void {
  if (relaunching) {
    logger.info('restart: already relaunching, ignoring the second request')
    return
  }

  relaunching = true
  logger.info('restart: relaunching the app')

  app.relaunch()
  app.quit()
}
