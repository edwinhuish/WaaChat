# 浏览器运行时评估：为什么会有第二个 Chromium，以及能不能换掉

> 本文是 [ADR-0044](../decisions.md#adr-0044)「影响」一节里那条**未实测项**的输入材料：
> 改用 `whatsapp-web.js` 之后，"浏览器"这件事从一件变成了两件。
>
> **它是评估，不是决定。** 结论被采纳后写进 `decisions.md` 的 ADR；本文按 `docs/research/` 的约定
> **只增不改**（反映当时的判断）。

---

## 0. 结论摘要

| 问题 | 结论 |
|---|---|
| 为什么还要另外引入一个 Chromium？ | **不是我们选的。** `whatsapp-web.js` 把 `puppeteer` 列为运行时依赖，而 puppeteer 的安装脚本会下载它自己的 Chrome。它与 Electron 内置的那份是**两个独立的浏览器发行包**。 |
| 换成 Playwright 可行吗？ | **不可行**（除非 fork 该库）。见 §4。 |
| 换成"复用已有的浏览器"可行吗？ | **可行**，有两条路（系统 Chromium / Electron 自带），各有明确代价。见 §3 的 B、C。 |
| 建议 | **采用方案 A**（用 puppeteer 自带的 Chrome），把 B、C 记为"已评估、暂不采用"。理由与各自的**重启触发条件**见 §5。 |

---

## 1. 事实基础（都可核对）

| # | 事实 | 来源 |
|---|---|---|
| F1 | `whatsapp-web.js` 的运行时依赖包含 `puppeteer`（`^24.38.0`），**不是可选依赖** | 该库 `package.json` |
| F2 | 它的源码**硬写** `require('puppeteer')`，并按 `puppeteer.launch` / `puppeteer.connect` 二选一启动；登录态、`page.evaluate`、`exposeFunction` 全都建立在 puppeteer 的 `Page` 上 | 该库 `src/Client.js` |
| F3 | **没有驱动抽象层**：公开类型里直接写着 `pupPage: puppeteer.Page` | 该库 `index.d.ts` |
| F4 | 但**启动参数可由调用方覆盖**：`ClientOptions.puppeteer` 的类型是 `PuppeteerNodeLaunchOptions & ConnectOptions`，因此 `executablePath` / `channel` / `browserWSEndpoint` / `args` 都能传进去 | 该库 `index.d.ts` / `src/Client.js` |
| F5 | 它还会注入一个硬编码启动参数 `--disable-blink-features=AutomationControlled`（隐藏 `navigator.webdriver`） | 该库 `src/Client.js`（这一点已如实写进 [`../../DISCLAIMER.md`](../../DISCLAIMER.md) 第 2 节） |
| F6 | puppeteer **24.38.0** 固定下载 **Chrome `146.0.7680.31`** | puppeteer 仓库 `puppeteer-v24.38.0` 的 `packages/puppeteer-core/src/revisions.ts` |
| F7 | 本仓库当前是 **Electron 44.7.0**；它自带的 Chromium 是 15x，`src/shared/user-agent.ts` 的示例值是 `150.0.7871.129`（真实值取自运行时的 `process.versions.chrome`） | `node_modules/electron/dist/version`、`src/shared/user-agent.ts` |
| F8 | **本仓库特有的坑**：`pnpm-workspace.yaml` 的 `allowBuilds` 是白名单，任何带 build script 的依赖不表态，pnpm 12 会以 `ERR_PNPM_IGNORED_BUILDS` **硬失败**（不是警告）。而 puppeteer 的 install script 正是"下载 Chrome"那一步 | [`../../pnpm-workspace.yaml`](../../pnpm-workspace.yaml) 顶部注释 |

**F7 值得单独说一句**：Electron 44 自带的 Chromium（15x）比 puppeteer 固定下载的 Chrome（146）**更新**。
所以"额外那个 Chromium"不是"补一个更强/更兼容的浏览器"，只是"多一份同量级的浏览器"。

---

## 2. 为什么会多出一个 Chromium

三条事实叠加的结果，责任不在本项目的选型：

1. Electron 把 Chromium **编进了自己的可执行文件**里，它不是磁盘上一个可供第三方随便驱动的 `chrome` 二进制；
2. `whatsapp-web.js` 是 **puppeteer 客户端**（F2/F3），它需要"一个能被 puppeteer 启动或连接的目标浏览器"；
3. puppeteer 的默认行为就是**自己下载一个 Chrome** 来当那个目标（F6）。

所以在 [ADR-0044](../decisions.md#adr-0044) 选定"独立 Chromium"之后，磁盘上就同时存在两份完整 Chromium：
Electron 那份（承载本地界面 + 归档层），以及 puppeteer 那份（承载网页版）。
**"要不要这份多的"这个问题，实质是"目标浏览器从哪来"** —— 下面三个方案就是在回答它。

---

## 3. 三个方案的对比

| 维度 | **A. puppeteer 自带 Chrome** | **B. 指向系统 Chromium / Chrome** | **C. 复用 Electron 自带的 Chromium** |
|---|---|---|---|
| 怎么做 | 零配置（默认） | `ClientOptions.puppeteer.executablePath` 或 `channel`（F4） | `ClientOptions.puppeteer.browserWSEndpoint` 指向 Electron 的 `--remote-debugging-port`（F4） |
| 额外磁盘占用 | **多一份完整 Chromium**（下载到 `~/.cache/puppeteer`） | **0** | **0** |
| 安装期网络依赖 | **有**：装依赖时要下载 Chrome | 无 | 无 |
| 用户机器的前提 | 无 | **必须有版本够新的 Chromium / Chrome** | 无 |
| 版本可控性 | **高**：钉死 146 | **低**：取决于发行版（Debian/Ubuntu 的 chromium 常落后） | 中：跟随 Electron 升级，是 15x |
| 与 WhatsApp Web 的兼容风险 | 低（版本新且固定） | **高**：版本过旧时页面可能直接打不开，而症状是"白屏或功能缺失" | 低（15x 更新） |
| 与 [ADR-0044](../decisions.md#adr-0044) 的一致性 | 一致 | 一致 | **冲突** —— 本质是走回被否决的 `wwebjs-electron` 路线 |
| 主要风险 | 体积；CI/离线下安装失败（F8） | 版本漂移；AppImage 用户可能根本没有 | 两套浏览器生命周期耦合；ADR-0044 理由 2/3 全部失效 |
| 打包动作 | 要回答"Chrome 从哪来"（装包时下载 or 预置） | deb 需加 `Depends:`；AppImage 需文档指引 | 无 |

> **尺寸数字一律没有写。** 两份都是完整的 Chromium 发行包，属同一数量级；具体兆数必须用
> `pnpm run pack` 实测（这正是 [ADR-0044](../decisions.md#adr-0044) 列出的未实测项，本文不替它下结论）。

---

## 4. Playwright 能不能替换 puppeteer？—— 不能

四条理由，前三条各自独立成立：

1. **这不是"换库"，是"改库"。** `whatsapp-web.js` 硬写 `require('puppeteer')`（F2），公开类型里也是
   `puppeteer.Page`（F3），**没有驱动抽象层**。想用 Playwright 就得维护一个 fork，并跟着上游每次改动
   重新打补丁 —— 那是个活跃仓库，这笔维护成本是**永续**的。
2. **Playwright 的 Electron 支持是实验性内部 API。** 官方把它放在 API 参考的 **Experimental** 分类下，
   并明确写着 `const { _electron } = require('playwright')` —— 下划线前缀即"内部"。它的用途是
   **启动并自动化一个 Electron 应用**（拿窗口、截图、点按钮、`close()`），不是"给一个页面当驱动"。
   本项目的需求是驱动 `web.whatsapp.com` 这个页面，与它的设计目标不吻合。
3. **换过去并不省下那份 Chromium。** Playwright 同样需要 `playwright install` 拉它自己的浏览器。
   "减少一个浏览器"这个目的，换 Playwright **一个都达不到**。
4. **两边的 API 相似但不等价**（`exposeFunction`、`waitForFunction`、下载事件语义、`webVersionCache`
   这一类都建立在上游库的实现细节上）。改写面几乎覆盖整个库。

**结论：不替换。**

---

## 5. 建议

### 采纳 A（puppeteer 自带的 Chrome）

理由按权重排序：

1. **把"页面能不能打开"这个失败模式的概率压到最低。** 这条链路上最怕的不是多占磁盘，而是
   **版本漂移导致页面白屏，且症状不可归因**（B 的核心风险）。A 把版本钉死在 146，是"已知能跑"的配置。
2. **不引入新的用户机器前提。** B 要求用户系统里有够新的 Chromium —— 这对 AppImage 用户是**不可控前提**，
   而 AppImage 恰恰是本项目的分发格式之一。
3. **不引入架构冲突。** C 会推翻 [ADR-0044](../decisions.md#adr-0044) 的理由 2 与理由 3，而那两条理由
   （信任边界更清晰、避免两套浏览器生命周期耦合）不因为"省一份磁盘"而失效。

### 落地时必须处理的两件事（本仓库特定）

1. **`allowBuilds` 必须显式表态 `puppeteer`**（F8）。走 A 就得在 [`../../pnpm-workspace.yaml`](../../pnpm-workspace.yaml)
   里写 `puppeteer: true`，否则 pnpm 12 会让 `pnpm install` 直接失败；而
   "批准"意味着**每次安装都会下载 Chrome**（离线安装会失败，这条要写进 `docs/packaging.md`）。
   另一条路是改用 `puppeteer-core`（不带下载）+ 显式 `executablePath`，那就退回方案 B/C 的取舍。
2. **打包要回答"Chrome 从哪来"**：装包时下载，还是打进产物。这直接决定 deb/AppImage 的体积与
   离线可安装性。**必须实测后再定**（ADR-0044 的未实测项，本文不代它结论）。

### B / C 的重启触发条件（写下来，免得将来重新发明）

- **重启评估 B**：当"分发体积"或"安装期下载失败"成为**实际阻塞**（用户投诉、CI 不稳定、体积超阈值）
  时，再评估 B，并按目标发行版补 `Depends:`。
- **重启评估 C**：只有当"尽可能小的分发体积"升级成**硬需求**时，才回头重新审视
  [ADR-0044](../decisions.md#adr-0044)。那不是本评估能单方面推翻的决定。

---

## 6. 本评估的局限

- **一个方案都没实测。** 体积、启动耗时、离线安装、CDP 兼容性全部属于**待验证**；本文只做结构对比
  与风险排序，不声称任何实测结论。
- 关于 `whatsapp-web.js` 与 puppeteer 的事实取自各自的 **`main` / 固定 tag 快照**（F1–F6），它们会变；
  升级这两个依赖时应复查 F2/F3/F4/F6（F2/F3 决定"能不能换驱动"，F6 决定"能不能钉版本"）。
