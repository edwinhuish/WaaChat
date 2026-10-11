/**
 * 内核自带的拼写检查（Hunspell）。
 *
 * 这一项在架构上是**零风险**的：红波浪线由渲染进程自己画，纠错建议走主进程的右键菜单，
 * 我们既没有往被承载的页面里写任何东西（与 [INV-1] 无关），也没有碰加密（与 [INV-3] 无关）。
 * 唯一的动作是"告诉内核要查哪些语言"。
 *
 * 唯一的对外副作用是**词典的下载**：内核按需从下载源取 `<语言码>.bdic`。我们把那个源换成了
 * Edge 在用的那一个（{@link DICTIONARY_DOWNLOAD_URL}，理由见 [ADR-0068]），取舍写在
 * `docs/security.md` 第 2 节，而**关掉整个功能的那个开关同时就是"不要发起这个请求"的开关** ——
 * 因此 `Settings.spellcheck` 关着时这里什么都不碰。
 *
 * 只 `import type` electron，不 import 它的运行时代码：判据（{@link resolveSpellcheckLanguages}）
 * 因此可以在不启动 Electron 的情况下被断言（与 `permissions.ts` 同一个理由）。
 */

import type { Session } from 'electron'

import { resolveSpellcheckLanguages } from '../shared/language'
import type { Settings } from '../shared/types'
import { logger } from './logger'

/**
 * 词典下载源。**不是内核的默认值**（那是 `https://redirector.gvt1.com/edgedl/chrome/dict/`，
 * Google 托管的 CDN，见 [ADR-0061]）—— 换源的理由与实测证据在 [ADR-0068]。
 *
 * 一句话：默认源在目标网络里会**挂死**（302 到 `*.gvt1-cn.com` 之后请求停在半路），既不成功
 * 也不失败，于是内核连 `spellcheck-dictionary-download-failure` 都不发 —— 用户看到的是
 * "设置页一切正常、输入框里一条红线都没有"，而这正是本项目最讨厌的那种失败。
 *
 * 这一条是 Microsoft Edge 自己在用的源（从 `msedge` 里读出来的），而它给的是**同一批文件**：
 * 实测 `en-us-10-1.bdic` 与 Electron/VS Code 从默认源下到的那一份 sha256 **逐字节相同**，
 * 且对我们这 24 门语言逐一返回 302（对伪造的名字返回 400，即它**校验**文件名）。因为会答话，
 * 失败在这一条路上是**可见**的。
 *
 * ⚠️ 规范上它是外部服务的地址（[ADR-0068] 的"已知限制"）：不是给第三方用的公开接口，
 * 随时可能变。要改它，先读那条 ADR。
 */
const DICTIONARY_DOWNLOAD_URL = 'https://edge.microsoft.com/redirectordictionaries/dict/'

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

  /**
   * 换源（[ADR-0068]）。它必须在 `setSpellCheckerLanguages()` **之前** —— 后者就是发起下载的
   * 那一个调用。放在这里（早于下面**每一个**分支）是为了让内核接下来自己发起的任何下载都用这个源，
   * 包括"内核还没给出清单"那一支里它按自己的默认值去取的那些。
   */
  ses.setSpellCheckerDictionaryDownloadURL(DICTIONARY_DOWNLOAD_URL)

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
 *   2. `spellcheck-dictionary-download-failure` —— 词典没能从下载源取回来（那个源由
 *      {@link DICTIONARY_DOWNLOAD_URL} 指定，取舍见 `docs/security.md` 第 2 节）。它**没有
 *      别的症状**：设置页一切正常、输入框里却没有红线，因此日志与通知两样都要有。
 *      ⚠️ 这个事件**不是所有失败都会发**：默认源在目标网络里的那种失败是"请求停在半路"，
 *      内核一个字都不说（[ADR-0068] 的实测）—— 换源之后这类失败才变成会答话的失败。
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
