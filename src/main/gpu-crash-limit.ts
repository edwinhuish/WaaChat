/**
 * GPU 进程反复失败时，别让整个应用跟着退出（[ADR-0090]）。
 *
 * ── 没有这个开关会发生什么（真机取证，2026-10-18）──
 *
 * 用户注销会话的那一刻，systemd 对 `app-…-waachat-<pid>.scope` 里的**所有**进程同时发
 * SIGTERM —— 主进程、zygote、GPU、网络服务一起收到。主进程这边走的是 Chromium 的正常退出
 * 路径，于是它看到的是"子进程全没了"：
 *
 * ```
 * 23:22:31.426  Failed to send GetTerminationStatus message to zygote        ×4
 * 23:22:31.439  Network service crashed or was terminated, restarting service.
 * 23:22:31.458  GPU process launch failed: error_code=1002                  ×6
 * 23:22:31.460  FATAL:…/gpu_data_manager_impl_private.cc:417] GPU process isn't usable. Goodbye.
 * ```
 *
 * 从 zygote 死到 FATAL 只有 **34 ms** —— 这中间主进程做的事情是"再起一个 GPU 进程"，而 zygote
 * 已经不在，于是每次都失败。**失败三次就 `LOG(FATAL)`**：整个浏览器进程被自己打死，apport
 * 在下次登录时弹一个「WaaChat 已意外关闭」。栈上那个 SIGTRAP 是二级现象（FATAL 的日志输出
 * 撞上 libc++ 的 `string_view::substr` 硬化断言，`__libcpp_verbose_abort` 直接 `int3`），
 * 追它没有意义。
 *
 * ── 为什么关掉的是"计数"而不是"别的" ──
 *
 * 那段代码的形状（`gpu_data_manager_impl_private.cc`，本机 Electron 44.7.0 反汇编核对）：
 *
 * ```
 * call CommandLine::ForCurrentProcess()
 * lea  rsi, "disable-gpu-process-crash-limit"
 * call HasSwitch            ← 有开关就**跳过后面的 FATAL**
 * test al, al / jne  <skip>
 * cmp  [gpu_process_crash_count_], 3
 * jl   <skip>               ← 失败次数 < 3 也跳过
 * LOG(FATAL) << "GPU process isn't usable. Goodbye."
 * ```
 *
 * 也就是说这个开关**正好挡在那条 FATAL 前面**，是命令行上唯一能拦住它的东西。
 *
 * ── 代价写在明处 ──
 *
 * 关掉之后 GPU 进程起不来时内核**不再自杀**，而是退回软件渲染（并继续按退避重试）。对这个
 * "承载官方网页的壳"来说这是正确的一侧：聊天、语音、视频通话都不该因为 GPU 进程抖一下就
 * **整个应用消失**。同时它也顺手治了另一种真事 —— 显卡驱动把 GPU 进程打崩三次，从前同样是
 * 应用直接死掉（那时用户看到的也是"意外关闭"，而日志里一个字都没有）。
 *
 * ── 边界 ──
 *
 *   1. **用户自己写了这个开关就不动**（`hasSwitch`，不是 `getSwitchValue`：布尔开关不带 `=`
 *      时后者返回空串，与"没写"分不开 —— 与 `smooth-scroll.ts` 同一条坑）。
 *   2. **只加一个开关，什么都不覆盖。** 它不改变 GPU 是否被使用、也不改变后端选择 —— 那些是
 *      `linux-gpu.ts` 的事。
 *
 * 纯函数 + 可注入的命令行接口（与 `app.commandLine` 同形），因此能单测，不必真的等显卡崩三次。
 */

/**
 * 关掉"GPU 进程连续失败 N 次就 FATAL"的那个计数器。
 *
 * 名字在二进制里核对过（照 [ADR-0036] 的做法）：对这个 Electron 的 `dist/electron` 跑
 * `strings … | grep -c disable-gpu-process-crash-limit` 得 1，再用反汇编找到唯一一处引用
 * —— 就是上面那段紧挨着 `LOG(FATAL)` 的判定。上游改名的症状会是"这一条从此静默不生效"
 * （命令行上多一个没人认识的开关，Chromium 只忽略它），因此这条取证值得留在注释里。
 */
export const GPU_CRASH_LIMIT_SWITCH = 'disable-gpu-process-crash-limit'

/**
 * 我们用到的那部分 `app.commandLine`。
 *
 * 只需要这两个方法：一个用来判断"用户自己写了吗"，一个用来追加。
 */
export interface CommandLineLike {
  hasSwitch(name: string): boolean
  appendSwitch(name: string): void
}

/**
 * 追加开关，返回**是否真的动了命令行**（调用方据此记一条日志）。
 */
export function applyGpuCrashTolerance(cli: CommandLineLike): boolean {
  if (cli.hasSwitch(GPU_CRASH_LIMIT_SWITCH)) return false

  cli.appendSwitch(GPU_CRASH_LIMIT_SWITCH)

  return true
}
