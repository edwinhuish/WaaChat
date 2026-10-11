/**
 * 内核自带的拼写检查（Hunspell）。
 *
 * 这一项在架构上是**零风险**的：红波浪线由渲染进程自己画，纠错建议走主进程的右键菜单，
 * 我们既没有往被承载的页面里写任何东西（与 [INV-1] 无关），也没有碰加密（与 [INV-3] 无关）。
 * 唯一的动作是"告诉内核要查哪些语言"。
 *
 * 唯一的对外副作用是**词典的下载**：内核按需从默认的下载源（Google 托管的 CDN）取
 * `<语言码>.bdic`。它的取舍写在 `docs/security.md` 第 3 节，而**关掉整个功能的那个开关同时
 * 就是"不要发起这个请求"的开关** —— 因此 `Settings.spellcheck` 关着时这里什么都不碰。
 *
 * 只 `import type` electron，不 import 它的运行时代码：判据（{@link resolveSpellcheckLanguages}）
 * 因此可以在不启动 Electron 的情况下被断言（与 `permissions.ts` 同一个理由）。
 */

import type { Session } from 'electron'

import { resolveSpellcheckLanguages } from '../shared/language'
import type { Settings } from '../shared/types'
import { logger } from './logger'

/**
 * "用户勾的那一组词典还没能交上去"。
 *
 * 只有一种情况会置位：启动时内核还没给出词典清单（见 {@link applySpellcheck} 的第一支）。
 * 它存在的唯一目的是让 {@link watchSpellcheck} 知道"要不要在内核就绪后补交一次" —— 没有它，
 * 补交会在内核每次装载词典时都白跑一遍（那会被日志放大成噪音，而噪音会把真正的那几条埋掉）。
 */
let awaitingDictionaries = false

/**
 * 把「拼写检查」这一组设置写到会话上。
 *
 * 与 {@link applyUserAgentAndLanguages} 一样有两个调用点：启动时（早于任何窗口）与设置被改动
 * 之后 —— 而它**不需要**重载页面：`setSpellCheckerLanguages()` 对已存在的输入框立即生效，
 * 因为拼写检查是渲染进程在每次输入时向内核要素材的，不是页面自己渲染的。
 */
export function applySpellcheck(ses: Session, settings: Settings): void {
  if (!settings.spellcheck) {
    awaitingDictionaries = false
    ses.setSpellCheckerEnabled(false)
    logger.info('spellcheck: disabled')
    return
  }

  const available = ses.availableSpellCheckerLanguages

  /**
   * `available` 为空是一个**独立**的情况，不能与"勾的词典内核没有"混为一谈：它意味着内核此刻还没有
   * 给出清单（它来得及的第一时间不一定在这里）。
   *
   * 此时**保持内核默认**，而不是顺着下面的逻辑把检查器关掉 —— 后者会把一个本来是默认开启的功能
   * 变成默认关闭，而那正是本项目最讨厌的一类失败：安静的、看起来像"功能没做"。
   *
   * ⚠️ 但"保持内核默认"意味着**用户勾的那一组没有被交上去**（`session.ts` 在 `whenReady` 里
   * 调本函数，紧挨着会话创建）。只返回就会让那组设置在**整个运行期间**都不生效，而日志里只留
   * 一条 warn —— 因此这里记下 {@link awaitingDictionaries}，等内核把词典装好之后由
   * {@link watchSpellcheck} 补交一次。
   */
  if (available.length === 0) {
    awaitingDictionaries = true
    ses.setSpellCheckerEnabled(true)
    logger.warn('spellcheck: the kernel reported no dictionaries yet; keeping its defaults')
    return
  }

  awaitingDictionaries = false

  const { applied, rejected } = resolveSpellcheckLanguages(settings.spellcheckLanguages, available)

  /**
   * 被丢掉的那些**必须留痕**：这一支是静默失效的入口 —— 用户勾了法语、内核没有那门词典，
   * 于是英文以外的词全被画上红线，而日志里只有这一条能说清为什么。
   */
  if (rejected.length > 0) {
    logger.warn('spellcheck: dropped dictionaries the kernel does not provide', {
      dropped: rejected.join(','),
      availableCount: available.length,
    })
  }

  /**
   * 一门都装不上时**显式关掉**检查器，而不是就这么返回：后者会把上一次设置里的词典留在内核里，
   * 于是"设置说一门都没勾、实际还在查英语"。宁可什么都不查 —— 但要说出来。
   */
  if (applied.length === 0) {
    ses.setSpellCheckerEnabled(false)
    logger.warn('spellcheck: no usable dictionary, the checker stays off')
    return
  }

  ses.setSpellCheckerEnabled(true)
  ses.setSpellCheckerLanguages([...applied])

  logger.info('spellcheck: enabled', {
    languages: applied.join(','),
    availableCount: available.length,
  })
}

/**
 * 订阅与词典有关的两类事件。**必须在 {@link applySpellcheck} 之后调用**（调用点见 `session.ts`）。
 *
 * 两条都是"静默失效"的入口，因此都在这里补上可见性 —— 与 `capture/health.ts` 那条
 * "允许失效，不允许静默失效"（`architecture.md` 第 5 节）是同一条纪律：
 *
 *   1. `spellcheck-dictionary-initialized` —— 内核把一门词典装好了。启动时若它还没给出清单
 *      （{@link applySpellcheck} 的第一支），这时才是那次补交的时机；不补的话，用户勾的词典在
 *      **整个运行期间**都不会生效，而设置页与日志都看不出异常。
 *   2. `spellcheck-dictionary-download-failure` —— 词典没能从下载源取回来（默认源是 Google
 *      托管的 CDN，见 `docs/security.md` 第 2 节）。它**没有别的症状**：设置页一切正常、
 *      输入框里却没有红线，因此日志与通知两样都要有。
 *
 * 接的是 `getSettings` 而不是一份快照：补交发生在启动之后的某个时刻，那时用户可能已经改过设置
 * （`settings.ts` 里"读当前值而不是注册时的那一份"是同一条理由）。
 *
 * 通知由调用方**注入**（`session.ts` 传 `announceDictionaryFailure`），而不是在这里 import
 * `notice.ts` —— 后者 import 了 `Notification` 的**运行时**代码，那样本模块就不再是"只
 * `import type` electron"（见文件头），而那是它能在离线自检/脚本里被引用的前提。这也与
 * `capture/health.ts` → `session.ts` → `notice.ts` 那条链路同形：判据留在这里，IO 只在装配处。
 *
 * 不订阅 `…-download-begin` / `…-download-success`：它们不改变任何决定，只会把日志撑大，
 * 而"哪一门词典最终可用"由 `initialized` 与 `availableSpellCheckerLanguages` 一起给出。
 */
export function watchSpellcheck(
  ses: Session,
  getSettings: () => Settings,
  onDictionaryFailure: (languageCode: string) => void,
): void {
  ses.on('spellcheck-dictionary-initialized', (_event, languageCode) => {
    logger.info('spellcheck: the kernel has a dictionary ready', { language: languageCode })

    if (!awaitingDictionaries) return
    applySpellcheck(ses, getSettings())
  })

  ses.on('spellcheck-dictionary-download-failure', (_event, languageCode) => {
    logger.warn('spellcheck: could not download a dictionary', { language: languageCode })
    onDictionaryFailure(languageCode)
  })
}
