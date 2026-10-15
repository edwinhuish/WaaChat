/**
 * 内嵌页面的**界面语言** → 拼写检查的词典（[ADR-0088]）。
 *
 * ── 它在解决什么 ────────────────────────────────────────────────────────────
 *
 * 词典清单写死的默认值是 `en-US`（[ADR-0061]）。而"用户在用哪种语言"的最强线索就在眼前：
 * 内嵌页面的界面语言 —— 它由**账号**决定（随账号同步下来的手机语言，`WALangPhonePref`），
 * 记在网页版自己那条 cookie `wa_web_lang_pref` 上（[ADR-0066] 的实测，
 * `docs/research/lang-preference.md` §4.4）。因此**首次**运行时就该按它选一门，而不是英语。
 *
 * ── 与 [ADR-0066] 的关系：只**读**，从不写 ──────────────────────────────────
 *
 * 那一条撤掉「界面语言」这一项，是因为**改**它做不成（三轮尝试全部证伪，最后一轮还撞在
 * INV-1 上）。这里一个字节都不写：`session.cookies.get()` 只读，判据（语言码 → 词典）是纯函数
 * （`shared/language.ts`）。顺带一提，`es_LA` / `en_GB` 这种值在页面按账号语言重写它之后，
 * 恰恰就是**账号语言**本身 —— 那次"我们改不动"的实测，正好是这里要读的那个事实。
 *
 * ── 它管两件事 ──────────────────────────────────────────────────────────────
 *
 *   1. **清单里有没有那一门**（[ADR-0088]，写设置）：见 `shared/language.ts` 的
 *      `adoptInterfaceDictionary()`。启动时只做"清单还停在写死的默认值上就换掉它"这一半 —— 磁盘上
 *      那条 cookie 是**上次**留下的值，拿它去改一份用户排过的清单就是在跟用户抢；**它真的变了**时
 *      （页面登录后写下账号语言、用户在手机上改语言）把那门补进清单的**第一位**，其余不动。
 *   2. **当前值是哪一个**（[ADR-0089]，进内存）：把它交给 `spellcheck.ts`（`setPageLanguage()`）。
 *      每一次装配拼写检查都要拿它从清单里**挑一门** —— 匹配得上就用那一门，匹配不上就用清单的第一门。
 *      只有这一份值（`spellcheck.ts` 里的那个变量），本文件判断"是不是真的变了"时也从那里读回去。
 *
 * ⚠️ 判断"真的变了"只看**值**：`docs/research/lang-preference.md` §4.5 实测页面会**同值重写**
 * 那条 cookie（11:54:28 与 11:54:50 两次），不过滤的话每次登录都会去动一遍用户的清单。
 */

import type { Cookie, Session } from 'electron'

import {
  PAGE_LANGUAGE_COOKIE,
  adoptInterfaceDictionary,
  isLanguageCode,
  matchDictionaryLanguage,
} from '../shared/language'
import type { Settings } from '../shared/types'
import { failureReason } from './errors'
import { logger } from './logger'
import { updateSettings } from './settings'
import { applySpellcheck, currentPageLanguage, setPageLanguage } from './spellcheck'
import { pushSettingsToSettingsWindow } from './window'

/** 一次"页面说的是哪种语言"的读取结果。 */
interface PageLanguage {
  /** 页面写下的原值（`es_LA` / `zh_CN`）。⚠️ 只有它看起来是语言码时才原样进日志。 */
  readonly raw: string
  /** 表里与之匹配的那一门；`null` = 我们这 24 门里没有对应（中文、日语…）。 */
  readonly dictionary: string | null
}

/**
 * 读一次界面语言。读不到返回 `null` —— 那**不是错误**：全新 profile 里它还不存在（它由页面
 * 与服务端说话之后创建），而那时该做的就是"什么都不做"。
 */
async function readPageLanguage(ses: Session): Promise<PageLanguage | null> {
  let cookies: Cookie[]
  try {
    cookies = await ses.cookies.get({ name: PAGE_LANGUAGE_COOKIE })
  } catch (error) {
    logger.warn('spellcheck: could not read the page language cookie', {
      reason: failureReason(error),
    })
    return null
  }

  /**
   * 同一个名字可能有多条（作用域不同）：先找能对上我们这张表的；一条都对不上时退到第一条 ——
   * 退那一步不是取词依据，只是为了把那个**值**带进日志（`zh_CN` 这类要能看出"为什么不跟"）。
   */
  for (const cookie of cookies) {
    const dictionary = matchDictionaryLanguage(cookie.value)
    if (dictionary !== null) return { raw: cookie.value, dictionary }
  }

  const first = cookies[0]
  return first === undefined ? null : { raw: first.value, dictionary: null }
}

/** 值进日志的形状：只有"看起来就是语言码"才原样打出来，否则只留长度（cookie 可能是凭据）。 */
function safeLanguage(value: string): string {
  return isLanguageCode(value) ? value : `len=${value.length}`
}

/**
 * 让词典清单跟界面语言走一次。
 *
 * @param page 已经读到的那一份（启动那条路与 cookie 变化那条路各自怎么拿到它，见两个调用点）
 * @param onLanguageChange 见 `shared/language.ts` 的 `adoptInterfaceDictionary()`
 * @returns 是否真的改了设置
 */
async function adopt(
  page: PageLanguage | null,
  ses: Session,
  getSettings: () => Settings,
  onLanguageChange: boolean,
): Promise<boolean> {
  if (page === null) {
    logger.info('spellcheck: the page has not told us its language yet; keeping the dictionaries')
    return false
  }

  if (page.dictionary === null) {
    logger.info('spellcheck: the page language has no dictionary in our list', {
      language: safeLanguage(page.raw),
    })
    return false
  }

  const previous = getSettings().spellcheckLanguages
  const next = adoptInterfaceDictionary(previous, page.dictionary, onLanguageChange)
  if (next === null) return false

  updateSettings({ spellcheckLanguages: next })

  /**
   * ⚠️ 改完设置必须**立刻**交给内核。设置里那一份与实际在查的那一份不是同一件事，正是这个文件
   * 想避免的那类失败。传的也是 `getSettings()`（刚写进去的那一份），不是 `previous`。
   */
  applySpellcheck(ses, getSettings())
  pushSettingsToSettingsWindow(getSettings())

  logger.info('spellcheck: the dictionary followed the page language', {
    language: safeLanguage(page.raw),
    dictionary: page.dictionary,
    from: previous,
    to: next,
  })

  return true
}

/**
 * 启动时的那一次：读一眼界面语言，把它记下来，必要时把**写死的默认值**换掉（[ADR-0088]）。
 *
 * ⚠️ **必须在启动时那次 `applySpellcheck()` 之前调用**，而且那次装配必须传**刚读到的**设置：
 * 这一支可能刚把清单换掉，拿动身之前的那份快照去装配会让内核查的与设置里显示的不是同一个
 * —— 顺带也让内核白下一门 `en-US`（[ADR-0072] 那条"设过的词典不会自己重来"的时序在这里同样成立）。
 */
export async function followPageLanguage(ses: Session, getSettings: () => Settings): Promise<void> {
  const page = await readPageLanguage(ses)

  // "还没有这条 cookie"与"认不出它"都记下来：`applySpellcheck()` 每次都要拿它挑一门（[ADR-0089]）。
  setPageLanguage(page?.raw ?? null)

  await adopt(page, ses, getSettings, false)
}

/**
 * 订阅界面语言的变化。
 *
 * ⚠️ 必须**早于任何窗口**：页面装载之后几秒内就会写下账号语言，晚一步就错过那一次
 * —— 而它的后果与 [ADR-0073] 那条一模一样：不是因为报错，而是因为**什么都没发生**。
 */
export function watchPageLanguage(ses: Session, getSettings: () => Settings): void {
  ses.cookies.on('changed', (_event, cookie, _cause, removed) => {
    if (cookie.name !== PAGE_LANGUAGE_COOKIE) return
    // 被删掉不是"换了语言"：那说明页面清了自己的状态，而下一轮它还会写回同一个语言。
    if (removed) return

    /**
     * 比的是**当前记着的那个值**（`spellcheck.ts` 里那一份，[ADR-0089]）。它过滤掉两件事：页面
     * **同值重写**（§4.5 实测会反复发生 —— 不过滤的话每次登录都会去动一遍用户的清单），以及别的
     * 作用域上那一条同名的 cookie 反复刷新。
     *
     * 比的是字符串而不是"上一次匹配到的词典"：语言码的形状由上游决定，我们只在**真的换了值**
     * 时才多看一眼 —— 判据越窄，越不会误动用户的清单。
     */
    if (cookie.value === currentPageLanguage()) return

    setPageLanguage(cookie.value)

    void adopt(
      { raw: cookie.value, dictionary: matchDictionaryLanguage(cookie.value) },
      ses,
      getSettings,
      true,
    ).catch((error: unknown) => {
      /**
       * 这条路是**事件驱动**的，没有调用方接得住异常：设置落盘失败（磁盘满、只读）会在这里
       * 变成一条未处理的拒绝。它不影响拼写检查本身（清单保持原样），但必须留痕。
       */
      logger.warn('spellcheck: could not follow the page language', {
        reason: failureReason(error),
      })
    })
  })
}
