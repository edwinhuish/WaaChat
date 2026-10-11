/**
 * 开发探针的**注入源**：路径、一次性标记，以及要注入的那段代码。
 *
 * 为什么单独一个模块：这里全是路径推导与字符串拼装，可以**不加载 Electron** 地单测
 * （`ai/CONVENTIONS.md` 第 3 节：可单测的逻辑不要和 Electron API 混在一个文件里）。
 * 真正碰 `webContents` 的那一半在 `dev-probe.ts`。
 *
 * 两边**必须**用同一组常量：标记名写错一次，注入就静默退化成"立刻扫描"（见
 * {@link probeBootstrapCode} 的说明），因此它们在这里各只有一处定义，且
 * `test/unit/dev-probe-source.test.ts` 会把两件事**跑通**来验证，而不是比对字符串。
 */

import { join } from 'node:path'

/**
 * 探针本体在仓库里的位置（**相对**仓库根）。
 *
 * 刻意从磁盘读这一份，而不是复制源码或把它打进 bundle：
 *  - 它是 `test/fixtures/` 下唯一的那份探针，`test/unit/probe-media-metadata.test.ts`
 *    守着它的两条性质（绝不打印值、必须走原型链上的 getter）—— 复制一份等于让守卫失效；
 *  - 打包产物里既不该有这段行为，也不该带上这份文件，所以读取只在未打包时发生。
 */
export const PROBE_SOURCE_RELATIVE_PATH = 'test/fixtures/probe-media-metadata.js'

/** 探针挂在页面上的全局对象（`window.__waProbe`）。 */
export const PROBE_GLOBAL = '__waProbe'

/**
 * 「界面语言」那条探针（`test/fixtures/probe-lang-pref.js`），**相对**仓库根。
 *
 * 与媒体探针同一个理由读磁盘上那一份、同一个注入通道（`dev-probe.ts` 的那**一处**
 * `executeJavaScript` 调用点 —— 例外每多一处都要在源码里看得见，见 [ADR-0057]）。
 *
 * 它回答的是另一个问题（cookie / 页面存储里谁写着语言），因此单独一个夹具、单独一个全局对象：
 * 两者混在一起会让媒体探针那份守卫（`test/unit/probe-media-metadata.test.ts`）失去意义。
 */
export const LANG_PROBE_SOURCE_RELATIVE_PATH = 'test/fixtures/probe-lang-pref.js'

/** 语言探针挂在页面上的全局对象（`window.__waLangPref`）。 */
export const LANG_PROBE_GLOBAL = '__waLangPref'

/**
 * 一次性标记：注入方在求值**之前**设上它，探针就只装 API、不立刻扫描。
 *
 * 理由是时序：注入发生在 `did-finish-load`，那时上游的 store 往往还没起来，立刻扫描会把
 * "没找到消息集合"这条**假警报**打出来 —— 而它在粘贴流程里是一条真诊断（上游换了内部结构）。
 */
export const PROBE_BOOTSTRAP_FLAG = '__waProbeBootstrap'
export const PROBE_BOOTSTRAP_VALUE = 'inject'

/** 探针源码的绝对路径。未打包时 `app.getAppPath()` 就是仓库根（同 `integration/appicon.ts`）。 */
export function probeSourcePath(appPath: string): string {
  return join(appPath, PROBE_SOURCE_RELATIVE_PATH)
}

/** 语言探针源码的绝对路径（同 {@link probeSourcePath} 的依据）。 */
export function langProbeSourcePath(appPath: string): string {
  return join(appPath, LANG_PROBE_SOURCE_RELATIVE_PATH)
}

/**
 * 注入时求值的代码。
 *
 * 标记与源码放在**同一次求值**里：分两次会留下"标记已设、探针没装"的中间态 —— 那种状态下
 * 之后再手动粘贴本文件就会**不再自动扫描**（标记还挂在 window 上），症状是"粘了却没反应"。
 * 探针读完标记会把它删掉，因此它只对这一次注入生效。
 */
export function probeBootstrapCode(source: string): string {
  return `window.${PROBE_BOOTSTRAP_FLAG} = ${JSON.stringify(PROBE_BOOTSTRAP_VALUE)}\n${source}`
}

/** 问探针"上游就绪了吗"（只读，不打印）。由 `dev-probe.ts` 轮询。 */
export function probeReadyExpression(): string {
  return `window.${PROBE_GLOBAL}?.ready() === true`
}

/** 让探针扫描当前会话。 */
export function probeScanExpression(): string {
  return `window.${PROBE_GLOBAL}.scan()`
}
