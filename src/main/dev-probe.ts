/**
 * 开发模式：把「媒体元数据探针」自动装进承载上游页面的窗口。
 *
 * ── 为什么需要它 ──
 *
 * 探针本体（`test/fixtures/probe-media-metadata.js`）本来是**粘贴进控制台**用的：重启应用要
 * 重粘、刷新页面要重粘，而 P2/P3 要求"切一次会话就重扫一次" —— 粘贴于是成了整条流程里最贵
 * 的一步。这里在未打包时自动把它装上，控制台里直接就是 `__waProbe.scan()`。
 *
 * ── 为什么是 `executeJavaScript`，而不是给聊天窗口挂 preload ──
 *
 * 那扇窗口**不挂 preload** 是一条**结构性**保证：远程内容在结构上无法触达本地能力
 * （见 `window.ts` 顶部与 `docs/security.md` T1）。为了调试给它加一个 preload，等于把
 * "结构上不可能"换成"靠代码正确性"。从主进程注入页面则是 INV-1 的**明示例外**：只读元数据
 * 求值，且**只在未打包时**（例外由 [ADR-0057] 划定，[ADR-0046] 是它第一次使用）。
 *
 * ── 纪律 ──
 *
 * - **只在未打包时**注入：产物里既没有 `test/fixtures/`，也不该有这段行为。
 * - 注入的是磁盘上的**同一份**探针，不复制源码 —— 它的两条性质（绝不打印值、必须走原型链
 *   上的 getter）由 `test/unit/probe-media-metadata.test.ts` 守着，复制就等于让守卫失效。
 * - 探针自身只读元数据：不下载、不发请求、不读密钥。见探针文件头与 INV-3。
 */

import { readFileSync } from 'node:fs'

import { app, type BrowserWindow } from 'electron'

import { failureReason } from './errors'
import {
  PROBE_GLOBAL,
  PROBE_SOURCE_RELATIVE_PATH,
  probeBootstrapCode,
  probeReadyExpression,
  probeScanExpression,
  probeSourcePath,
} from './dev-probe-source'
import { logger } from './logger'

/** 上游是单页应用："页面加载完"不等于"store 已可用"，所以就绪与否要问探针自己。 */
const READY_POLL_INTERVAL_MS = 1000

/**
 * 轮询上限。
 *
 * 超时**不是**失败：探针已经装好了，只是上游还没把 store 拿出来（没登录、或还没同步完）。
 * 这时**不**扫描 —— 扫了只会打印一条假警报。用户可以自己 `__waProbe.scan()`。
 */
const READY_POLL_LIMIT = 30

/**
 * 给一扇窗口装上探针。**调用方不需要判断是否打包** —— 这里自己判断。
 */
export function attachDevProbe(window: BrowserWindow): void {
  if (app.isPackaged) return

  /**
   * 每次**完整加载**都重装一次：登录流程与上游自己刷新时，window 上的 `__waProbe` 会消失。
   *
   * 只挂钩 `did-finish-load`：单页应用内切会话不重新加载，探针本来就跨会话存活
   * （这正是 P2/P3 依赖的性质）。
   */
  window.webContents.on('did-finish-load', () => {
    void install(window)
  })
}

async function install(window: BrowserWindow): Promise<void> {
  const source = readProbeSource()
  if (source === null) return

  const injected = await evaluate(window, probeBootstrapCode(source))
  if (!injected.ok) return

  logger.info('dev probe: installed', {
    call: `${PROBE_GLOBAL}.scan()`,
    source: PROBE_SOURCE_RELATIVE_PATH,
  })

  await scanWhenReady(window)
}

/**
 * 等上游就绪后扫一次 —— "启动完就能看到结果"靠的是这一步，而不是在 did-finish-load 立刻扫。
 */
async function scanWhenReady(window: BrowserWindow): Promise<void> {
  for (let attempt = 1; attempt <= READY_POLL_LIMIT; attempt += 1) {
    if (window.isDestroyed()) return

    const ready = await evaluate(window, probeReadyExpression())
    if (ready.ok && ready.value === true) {
      await evaluate(window, probeScanExpression())
      logger.info('dev probe: scanned the open chat', { attempts: attempt })
      return
    }

    await delay(READY_POLL_INTERVAL_MS)
  }

  logger.warn('dev probe: the upstream store never showed up; call the probe by hand', {
    attempts: READY_POLL_LIMIT,
  })
}

/**
 * 读探针源码。
 *
 * 路径依据 `app.getAppPath()`：未打包时它就是仓库根 —— 与 `integration/appicon.ts` 读
 * `build/icon.png` 是同一个依据。
 */
function readProbeSource(): string | null {
  try {
    return readFileSync(probeSourcePath(app.getAppPath()), 'utf8')
  } catch (error) {
    /**
     * 只记仓库内的**相对**路径（`docs/security.md` T4）：相对目录名可以进日志，绝对路径不行。
     *
     * 这也不是用户可见的失败，而是开发环境的配置问题（比如探针被挪走了）—— 说清是哪个文件
     * 就够行动了。`test/unit/dev-probe-source.test.ts` 会断言这个文件确实在。
     */
    logger.warn('dev probe: cannot read the probe source', {
      source: PROBE_SOURCE_RELATIVE_PATH,
      reason: failureReason(error),
    })
    return null
  }
}

type Evaluation = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

/**
 * 在页面里求值。
 *
 * 失败**必须**有痕迹：注入不生效时最糟的症状是"控制台里没有 __waProbe，但没有任何提示"。
 * 这里的 `catch` 不是吞掉 —— 它把原因写进主进程日志，并从调用方可见的 `ok` 返回出去。
 */
async function evaluate(window: BrowserWindow, code: string): Promise<Evaluation> {
  try {
    // eslint-disable-next-line no-restricted-syntax -- 只读元数据探针，且只在未打包时（ADR-0057 例外）
    return { ok: true, value: await window.webContents.executeJavaScript(code) }
  } catch (error) {
    logger.warn('dev probe: evaluation failed', { reason: failureReason(error) })
    return { ok: false }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
