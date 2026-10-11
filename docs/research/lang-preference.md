# 界面语言：网页版把它记在哪儿、**谁能写它**，以及能不能不注入地改

> 目标：`wa_web_lang_pref` 这条 cookie 改掉就能换网页版的语言，但它**会被改回来**。在动手之前
> 必须先弄清"是谁改回去的" —— 两种来源的手段完全不同，而且其中一种**没有干净的解法**。
>
> **它是评估，不是决定。** 结论被采纳后写进 `decisions.md` 的 ADR；本文按 `docs/research/` 的约定
> **只增不改**。

---

## 0. 结论摘要

| 问题 | 结论 |
|---|---|
| 今天能不能换内嵌页面的语言？ | **能，但只在启动时**：`--lang` 决定 `navigator.language`，网页版据此挑语言包（[ADR-0063](../decisions.md#adr-0063)）。这一点**不由本次研究改变**。 |
| 本文要回答什么？ | `wa_web_lang_pref` 能不能当**第二条杠杆** —— 让语言"运行期可换、且不被服务端改回"。 |
| 它被改回来有几种可能？ | **两种**（§2）：A = 网络响应写的（可拦）；B = 页面脚本写的（拦不住，除非注入）。 |
| 有没有"向上游提交语言变更"这条路？ | **不建议**：那要调上游的私有接口、还要把页面的认证凭据取出来用 —— 撞 `AGENTS.md` 第 5 节最后一条与 [INV-2](../decisions.md#adr-0001) 的立场，且上游改版即静默失效（§5）。 |
| 怎么测？ | 两份只读探针（§3）：页面侧 `__waLangPref`（`test/fixtures/probe-lang-pref.js`）+ 主进程侧 `lang probe:` 日志（`src/main/dev-probe-lang.ts`），外加一次零风险的 `?lang=` 手工测试。 |
| 结果 | **待填**（§4）。 |

---

## 1. 为什么这件事值得单独研究

[ADR-0060](../decisions.md#adr-0060) / [ADR-0063](../decisions.md#adr-0063) 把"换语言"落在了
**表现得像一个普通浏览器**上（改请求头、改应用 locale），代价是**重启**才生效 —— 因为它要改的是
`navigator.language`（启动期开关）。这是 **INV-1 之下唯一成立的做法**，不是保守。

而 ADR-0063 的"已知限制"里挂着一条**至今未确认**的推测：

> **上游仍可能把语言存进页面存储**：那样它只在**首次装载**时跟随我们。

`wa_web_lang_pref` 这条 cookie 的出现，把这条推测变成了一个**可回答**的问题，而且顺带打开第二条
可能的杠杆：如果它**只由服务端写**，我们就能在会话层拦响应头把它固定住，从而做到"运行期可换"。

**⚠️ 但这条杠杆只在一种情况下存在**（§2 的形态 A）。因此本次研究的目的不是"实现它"，
而是**先定性**：它是 A 还是 B。

---

## 2. 判据：两种"被改回来"

| | 形态 A：网络响应写它 | 形态 B：页面脚本写它 |
|---|---|---|
| 机制 | 响应的 `Set-Cookie`（`webRequest.onHeadersReceived` 能看到） | `document.cookie = …`，或从页面存储读回来再写一次 |
| 我们能拦吗 | **能**：在会话层把那条 `Set-Cookie` 过滤掉，再用 `session.cookies.set()` 种我们的值 | **不能**（在 INV-1 下）。要拦只能注入，而注入是被禁止的那一类 |
| 判据之一 | cookie 带 `HttpOnly`（脚本写不出 HttpOnly） | `document.cookie` 里看得见它 |
| 判据之二 | cookie 变化的 `cause` 不是 `explicit` | `cause` 是 `explicit` |

⚠️ **两条判据都要看，而且必须一起看**：`document.cookie` 里看不见它**不等于**它是 HttpOnly ——
也可能是"此刻还没被写过"（页面刚装载时很常见）。只凭页面侧一条就下结论，会得出一个建立在
错误前提上的改动方案。

⚠️ **形态 B 还有一层**：即使服务端是唯一的直接写入者，页面也可能把它**存进页面存储**、之后从
那里写回（ADR-0063 那条推测说的正是这个）。因此 §3 的页面侧探针要**同时**扫存储。

---

## 3. 怎么测（全部只读）

### 3.1 页面侧：`__waLangPref`

`test/fixtures/probe-lang-pref.js`，开发模式下由 `src/main/dev-probe.ts` 自动装进承载上游页面的
窗口（**只在未打包时**，与媒体元数据探针走**同一处** `executeJavaScript` 调用点 ——
[INV-1](../decisions.md#adr-0057) 的只读例外每多一处都要在源码里看得见）。

它报三件事：

1. `wa_web_lang_pref` 在 `document.cookie` 里**看不看得见**（可见 ⇒ 不是 HttpOnly；不可见 ⇒ 见 §2 的警告）；
2. 页面存储里有没有**疑似语言键**（localStorage / sessionStorage 的键名与规范化后的值；
   IndexedDB 只列**库名** —— 库里是消息内容，不进去读）；
3. `navigator.language` / `navigator.languages` / `Intl` 的取值，与 `--lang` 对照。

```bash
pnpm run dev        # 未打包时才装；装完自动取一次快照
# Ctrl+Shift+I → Console：
__waLangPref.report()          # 整段复制出来
await __waLangPref.refresh()   # 过一会儿（或改了语言之后）再看一次
```

⚠️ **要看"过一会儿"那一次**：服务端把 cookie 改回来多半发生在一次会话同步或一段空闲之后，
页面刚装载完的那一瞬间看不出任何东西。

### 3.2 主进程侧：`lang probe:` 日志

`src/main/dev-probe-lang.ts` 挂在**会话**上（因此必须在创建窗口**之前**装配 —— 要看到页面
第一次请求的响应头），报两件事：

- `lang probe: a response carries the language cookie` —— 哪一条响应发了这条 `Set-Cookie`，
  以及它带了哪些属性（`httpOnly` / `secure` / `sameSite` / `maxAge` …）。这是**形态 A 的直接证据**；
- `lang probe: cookie changed` —— 每次变化的 `cause`：`explicit` = 页面脚本写的（**形态 B**），
  其它取值 = 网络写回来的（**形态 A**）。

它**只观察**：`callback({})` 放行，一个字节都不改。日志纪律同 `docs/security.md`：cookie 值只有
"看起来就是语言码"才原样打出来，其余只报长度；地址只报 `origin + pathname`。

### 3.3 `?lang=` 那一问（零风险，手工）

上游不少网页应用认 URL 上的 `?lang=`。在**普通浏览器**里打开：

```
https://web.whatsapp.com/?lang=ja-JP
```

不登录、不改任何状态。**若登录页变成日语**，这就是最省事的一条杠杆（无需拦任何东西）；若不变，
这一条排除掉。（页面侧探针会顺手报出当前地址里的参数名与 `lang` 的值。）

---

## 4. 结果

### 4.1 已测：`--lang` 到 `navigator.language` 的映射（Electron 44.7.0，本仓库钉住的那一版）

做法：一个仓库外的临时探针（`xvfb-run` + 隐藏窗口 + `about:blank`），逐个把
`UI_LANGUAGES[].code` 交给 `app.commandLine.appendSwitch('lang', code)`，读 `app.getLocale()` 与
`navigator.language`。

| `--lang=` | `app.getLocale()` | `navigator.language` |
|---|---|---|
| （不设） | `zh-CN` | `zh-CN` |
| `zh-CN` / `zh-TW` / `en-US` / `en-GB` / `pt-BR` | 原样 | **原样** |
| `es-ES` / `ja-JP` / `tr-TR` / `hi-IN` / `vi-VN` / `th-TH` / `id-ID` / `ko-KR` / `fr-FR` / `de-DE` / `it-IT` / `ru-RU` | 基础码（`es` / `ja` / …） | **基础码** |

**结论**：

1. **机制有效**：表里每一个码都真的改变了 `navigator.language`（`navigator.languages` 的第 0 项），
   没有一个是"设了等于没设"。因此"页面没换语言"**不能**再从这一层解释。
2. **区域变体会被规范化成基础码**：`es-ES` → `es`。因此"请求的值 ≠ 生效的值"是**预期内的**，
   判据必须比**基础语言**（`shared/language.ts` 的 `localeMatchesRequest`），否则每次都会报假警报。
3. **`navigator.languages` 的尾巴仍是系统语言**（`['es','zh-CN','zh-CN','zh','zh']`）——
   与 [ADR-0063](../decisions.md#adr-0063) 的已知限制一致，这一条没有杠杆。
4. ⚠️ **附带补上一条诊断**：`--lang` 若给了一个内核不认的码，它会**静默回落到系统 locale** ——
   设置页照常显示用户选的那一种。因此 `main/index.ts` 的 `ready` 日志现在同时记
   `requestedLanguage` 与 `locale`，两者不同属一门语言时再报一条 warn。

### 4.2 待测：页面侧那两问

> 把 §3 的三份输出贴在这里。**结论要按 §2 的判据写**，别把"看不见 cookie"直接当成 HttpOnly。

| 观测 | 结果 |
|---|---|
| 页面控制台里 `navigator.language`（应为请求语言的规范化形式，如 `es`） | 待测 |
| `wa_web_lang_pref` 在 `document.cookie` 里可见？ | 待测 |
| 服务端发过 `Set-Cookie`？（`lang probe:` 那几行） | 待测 |
| cookie 变化的 `cause` | 待测 |
| 页面存储里有没有语言键 | 待测 |
| `?lang=ja-JP` 是否改变登录页语言 | 待测 |
| **登录页（全新 profile，未登录）是否跟随 `navigator.language`** | 待测 |
| ⇒ 形态 A 还是 B | 待测 |

⚠️ 最后第二行是**最有信息量的那一问**：它不需要登录。用两个全新 profile 分别以
`--lang=zh-CN` 与 `--lang=es-ES` 加载 `https://web.whatsapp.com/`，比较登录页文案 ——
- 若两者**不同** ⇒ 页面**首次装载**确实跟随我们，那么"重启后仍是中文"只可能是
  **页面自己的持久化偏好**（cookie / 存储）盖住了它 ⇒ 回头看 §2 的形态 A / B；
- 若两者**相同**（都是中文）⇒ 上游挑语言的根本不是 `navigator.language`，
  [ADR-0063](../decisions.md#adr-0063) 的整个机制要重新评估 —— 那时"重启后生效"这句文案
  在设置页里就是一句**不成立**的承诺。

---

## 5. 被否决的替代方案

- **调上游的私有接口去"提交语言变更"**：那等于自己实现一段上游协议。要做就得从页面里取出认证
  凭据、在外面重发请求 —— 撞 `AGENTS.md` 第 5 节最后一条（接管逻辑只允许依赖**标准内核行为**）
  与 [INV-2](../decisions.md#adr-0001) 的立场，且上游改版即**静默失效**。**除非**上游自己在网页版
  里提供语言开关（或认 `?lang=`，见 §3.3）—— 那就走它，我们一个字都不用碰。
- **注入脚本去点页面里的语言菜单**：违反 [INV-1](../decisions.md#adr-0057)，且依赖上游 DOM。
- **清掉页面存储让它重新挑一次语言**：连登录态一起清（[ADR-0008](../decisions.md#adr-0008) 的立场：
  绝不代用户清除）。
- **靠"不停把 cookie 改回去"（`cookies.on('changed')` + 立刻 `set()`）**：看着能赢，实际会与上游
  自己的语言选择器**打架**（用户主动改也被秒改回来），而且有竞态。**形态 B 下它同样无效。**

---

## 6. 与既有决定的关系

- 本文**不动** [ADR-0063](../decisions.md#adr-0063) 的结论：`--lang` 仍是启动期那一半，
  "重启后生效"不变。本文要回答的是**要不要再加一条运行期的杠杆**，以及在 INV-1 之下它是否存在。
- 若结论是**形态 A 且值得做**：那是一次**新的接管**（此前我们只**读**请求，没有**改**响应），
  按 `AGENTS.md` 第 4 节必须先追加一条 ADR，再动手。
- 若结论是**形态 B**：这件事到此为止 —— 在 INV-1 之下没有干净的解法，把它写进 ADR-0063 的
  "已知限制"就够了（那正是 §1 引的那条推测的归宿）。
