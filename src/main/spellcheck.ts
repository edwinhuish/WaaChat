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
 * 把「拼写检查」这一组设置写到会话上。
 *
 * 与 {@link applyUserAgentAndLanguages} 一样有两个调用点：启动时（早于任何窗口）与设置被改动
 * 之后 —— 而它**不需要**重载页面：`setSpellCheckerLanguages()` 对已存在的输入框立即生效，
 * 因为拼写检查是渲染进程在每次输入时向内核要素材的，不是页面自己渲染的。
 */
export function applySpellcheck(ses: Session, settings: Settings): void {
  if (!settings.spellcheck) {
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
   */
  if (available.length === 0) {
    ses.setSpellCheckerEnabled(true)
    logger.warn('spellcheck: the kernel reported no dictionaries yet; keeping its defaults')
    return
  }

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
