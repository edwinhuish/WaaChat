# 宿主运行时迁移评估：把 Electron 换成 Tauri / Wails / 其它

> **它是评估，不是决定。** 结论被采纳后写进 `docs/decisions.md` 的 ADR；本文按 `docs/research/`
> 的约定**只增不改**（反映 2026-10-11 的判断）。
>
> 提问：能不能把宿主从 Electron 换成 Tauri、Wails 或别的架构？换了对性能、安全、跨平台、开发体验、
> 生态与长期维护各有什么利弊？
>
> 一句话回答：**不能换掉的是内核，不是框架。** 本项目的价值集中在两个"内核层接管点"上
> （[ADR-0001](../decisions.md#adr-0001)），而它们在 Linux 上（本项目**唯一**的目标平台，
> [roadmap 明确不做 Windows / macOS](../roadmap.md)）的替代宿主里**不存在对等实现**。

---

## 0. 结论摘要

| 方案 | 能保住两个接管点吗 | 包体积 | 判定 |
|---|---|---|---|
| **A. 保持 Electron**（现状 + 边角裁剪） | ✅ 原样 | 283 MB（实测，解包） | **推荐** |
| **B. Tauri v2**（Linux = WebKitGTK） | ❌ 接管点 B 无实现路径；接管点 A 只能部分重建 | 个位数 MB + 系统 WebKitGTK | 否决（**产品核心功能会消失**） |
| **C. Wails v2/v3**（Linux = WebKitGTK，后端 Go） | ❌ 同上，且后端要换成 Go | 个位数 MB + 系统 WebKitGTK | 否决（同上，另加 v3 尚在 Beta） |
| **D. Tauri + CEF**（Chromium 后端，fork 路径） | ⚠️ 理论可行，需大量未验证工作 | 回到与 Electron 同量级 | 仅在 A 被外部条件推翻时才考虑 |
| **E. 其它**（NW.js / 直接 CEF / 系统 Chrome + 本地代理 …） | ❌ 或违反不变量 | — | 逐条否决，见 §4 |

**推荐**：**不迁移**。理由按权重排序（完整版见 §6）：

1. 迁移会把**核心功能整体删掉**：密文缓存"命中即零网络"依赖 `protocol.handle('https')`，
   非 Chromium 宿主没有对等能力（§3.3）。
2. Linux 恰好是 Tauri / Wails 用 WebKitGTK 的平台 —— 换了之后是**最差组合**，而跨平台收益为
   **零**（目标平台就是 Linux）。
3. 引擎版本责任从"我们钉死"变成"发行版决定"，与 [browser-runtime-assessment.md](browser-runtime-assessment.md)
   §3 里**已被否决**的"用系统浏览器"那份取舍完全同构（§5.6）。
4. `src/main/` 的 8.4k 行（接管 + 归档，项目全部价值）要整体重写成 Rust / Go，其中归档层是最
   正确性敏感的部分（去重、硬链接、原子改名、LRU 淘汰、迁移回滚）。
5. 体积 / 启动 / 内存**不是**本项目的判据（"接管是否可靠"才是）；迁移对前者的收益是几十 MB
   量级，对后者只减不增。

---

## 1. 事实基础：本项目的运行时依赖清单（都可核对）

### 1.1 两个接管点各自依赖什么

| 接管点 | 实现的 API | 位置 |
|---|---|---|
| **A · 下载接管**（"点击即开"） | `ses.on('will-download')` + `DownloadItem.setSavePath / getFilename / getMimeType / getTotalBytes / getState / cancel / once('done')` | `src/main/capture/download.ts:66,89,110,112,113,121,173,189` |
| **B · 密文缓存**（二次打开零网络） | `ses.protocol.handle('https', …)`（命中时合成 `Response`，本地文件流） | `src/main/capture/protocol.ts:111,290-292` |
| **B 的直通路径** | `ses.fetch(url, { bypassCustomProtocolHandlers: true })`（**必须**发回同一分区会话，否则 `Set-Cookie` 进错罐子 —— [ADR-0033](../decisions.md#adr-0033)） | `src/main/capture/protocol.ts:218-245` |
| **B 的请求角色还原** | `ses.webRequest.onBeforeRequest`（**只读**观察者，[ADR-0058](../decisions.md#adr-0058)） | `src/main/capture/protocol.ts:106-109` |
| 只读元数据求值（INV-1 例外） | `webContents.executeJavaScript`（`filehash` / `msg.id.remote`） | `src/main/capture/download.ts:204,231` |

### 1.2 与宿主绑定的其余能力

| 能力 | API | 位置 | 换宿主后 |
|---|---|---|---|
| 会话区（登录态） | `partition: 'persist:waachat'` | `src/main/window.ts:110` | **磁盘格式不通用** ⇒ 全体用户重新扫码 |
| 账号标识（归档第一层目录） | `Session.getStoragePath()` → Chromium `Local Storage/leveldb`；退级 `ses.cookies.get()` | `src/main/account.ts:125,190` | 无等价物 ⇒ 退化 `unknown-account` |
| UA 伪装 | `webContents.setUserAgent(buildUserAgent(process.versions.chrome))` | `src/main/window.ts:101,123`、`src/shared/user-agent.ts:35` | 只能给 WebKit 的 UA（**Chrome 的 UA 配 WebKit 内核是谎报**） |
| 权限白名单 / 屏幕共享 | `setPermissionRequestHandler` / `setPermissionCheckHandler` / `setDisplayMediaRequestHandler({useSystemPicker})` | `src/main/session.ts:32,45,58` | 需按 WebKit 的信号重写 |
| GPU / Wayland 开关 | `app.commandLine.appendSwitch(...)` | `src/main/linux-gpu.ts:117-138`、`src/main/index.ts:51` | WebKitGTK 无这些开关 ⇒ 整段变死代码 |
| 桌面身份 | `app.setDesktopName` / `requestSingleInstanceLock` / `second-instance` | `src/main/index.ts:67,81,96` | 各宿主有插件/配置，但要重新对齐（一大类"静默失效"见 §5.5） |
| 系统集成 | `Tray` + `Menu` / `shell.openPath` / `shell.showItemInFolder` / `Notification` / `dialog` / `nativeImage` / `setLoginItemSettings` | `src/main/integration/*`、`src/main/notice.ts`、`src/main/ipc/index.ts` | 有对等插件，但**逐项重写** |
| IPC | `contextBridge` + `ipcMain.handle`（17 条通道，`senderFrame` 来源校验） | `src/preload/index.ts:81`、`src/main/ipc/channels.ts:10-82`、`src/main/ipc/index.ts:88-109` | 换宿主 IPC（TS 侧可复用类型与文案） |

### 1.3 换宿主**不用**改的部分（已有的复用面）

- **完全与宿主无关**（纯逻辑，可原样搬或逐字照译）：`archive/layout.ts`、`archive/naming.ts`、
  `capture/cachekey.ts`、`capture/headers.ts`、`capture/retry.ts`、`capture/request-context.ts`、
  `capture/early-identity.ts`、`shared/*`（1780 行）、`renderer/*`（791 行，纯 DOM + `createImageBitmap`）。
- **不 import electron 但依赖 Node**：`paths.ts`、`logger.ts`、`permissions.ts`、`capture/cache-files.ts`、
  **整个 `archive/`（2481 行，含 `better-sqlite3` + FTS5）**。这一层在 Electron 下直接复用；
  在 Tauri / Wails 下**必须重写**（Rust / Go 的 SQLite 绑定要自己确认 FTS5 是否编进去 ——
  文件列表的搜索功能依赖它）。
- 测试面：`test/unit/` 27 个文件 **404 个用例，无一 import electron**（`vitest.config.ts` 禁止）。
  这意味着"纯逻辑"的测试可以留；但 `store / blobs / migrate / delete / export` 那些用例
  验证的是要重写的那一层 —— **测试留得下，被测代码留不下**。

### 1.4 实测数据（本机，2026-10-11）

| 指标 | 值 | 采集方式 / 偏差 |
|---|---|---|
| Electron 运行时（解包） | **283 MB**（`electron` 二进制本体 219 MB；`LICENSES.chromium.html` 20 MB；`resources.pak` 13 MB；`icudtl.dat` 11 MB；`locales/` 8.7 MB；`libvk_swiftshader.so` 4.5 MB；`libffmpeg.so` 2.7 MB） | `du -ah node_modules/electron/dist` |
| 二进制冷加载 | **0.08–0.09 s**，maxrss ≈ 160 MB | `electron --version` ×3（只是动态加载，**不是**应用启动） |
| 应用启动（spawn → 日志 `INFO ready`） | **1.02 s** | Xvfb + `--no-sandbox` + 沙箱化 XDG；`ready` 只代表"窗口建立、两层已挂、托盘已起"，**不代表页面可用**（无网络，页面是错误页） |
| 进程数 / 进程树 RSS 合计 | 13 个 / **≈ 1.13 GB**（峰值 1.24 GB） | 同上。⚠️ **RSS 求和会重复计算共享页**（219 MB 的二进制被每个进程映射一次），这个数是**上限**。正确指标是 PSS（需 root）。另外 Xvfb 下 GPU 进程反复启动失败、退到软渲染，也会抬高数值 |
| 内核版本 | Electron 44.7.0，Chromium **152.0.7977.130** | 运行日志 |
| 本机构建 Tauri / Wails 的前提 | ❌ 无 `cargo` / `rustc`；`webkit2gtk-4.1` **只有运行时、没有 dev 头文件**；无任何 WebKitGTK 浏览器（无 epiphany / surf / luakit） | 因此 **Tauri / Wails 一行都没实测** —— 本文里它们的所有数值都是"公开量级"，不是本仓库的测量结果 |

> **这一节的意义只有一条**：基线是量出来的，所以"迁移能省多少"这句话必须拿新数字说话，
> 而不是拿"Electron 又大又慢"的印象说话。283 MB / 1.0 s 在这个产品的判据里不是痛点（§6）。

---

## 2. 为什么这个问题由内核决定，而不是由框架决定

### 2.1 Web 技术栈这一面几乎没有差别

Tauri / Wails 与 Electron 的差别只在**后端语言**（Rust / Go vs Node）与**打包方式**。
本项目的 UI 是纯 DOM（791 行，两扇窗口），`shared/` 是纯类型与纯函数 —— 这一层谁都能跑。
**所以"开发体验"不是这次评估的分水岭。**

分水岭是：**谁提供浏览器内核，以及我们能不能在内核里观察/合成网络流量与下载。**

### 2.2 各平台的宿主内核（事实）

| 宿主 | Linux | macOS | Windows |
|---|---|---|---|
| Electron | Chromium（打进产物） | Chromium | Chromium |
| Tauri v2 / Wails | **WebKitGTK**（`webkit2gtk-4.1`，系统库） | WKWebView | WebView2（Chromium） |
| Tauri + CEF（fork 路径） | CEF（Chromium，随产物分发） | — | — |

目标平台只有 Linux（[roadmap](../roadmap.md) "明确不做"），所以上表要读的是**第 1 列**：
Tauri / Wails 在这里给的是 **WebKitGTK**。

### 2.3 WebKitGTK 能做什么、不能做什么（查的是官方 API 参考）

| 需求 | WebKitGTK 的对应能力 | 结论 |
|---|---|---|
| 观察"页面发起了一次下载" | `WebKitDownload` + `decide-destination` / `created-destination` / `received-data` / `failed` / `finished`，且可 `set_destination()` 指定路径、`cancel()` 取消、`get_response()` 拿响应、`get_estimated_progress()` 估进度 | **可部分重建**。缺失的是：原文件名之外的 MIME / 总字节数 / 明确的状态机（`getState()`），以及"下载前作废这次下载"的那套时序 |
| **合成**对任意 `https://` 请求的响应（缓存命中零网络） | 只有 `register_uri_scheme`（**自定义 scheme**）。`WebKitWebContext` 的完整方法表里**没有任何通用请求拦截**入口（只有 DNS 预取、清缓存、cookie 管理器、TLS 例外） | **做不到**。这是本项目最关键的缺口 |
| 按资源粒度观察请求（还原 `Sec-Fetch-*` / `Referer`） | 仅存在于 **web process extension** 的 `WebKitWebPage::send-request`（可改写 URI、可取消；扩展是 `.so`，由 `webkit_web_context_set_web_extensions_directory()` 加载进 **web 进程**） | 存在，但它是**另一套 API**，且 Tauri **不暴露**；用得上就只能绕过 Tauri 的抽象、并且把我们的原生代码放进**渲染进程侧** |

> `send-request` 意味着一条**理论上**的替代路径：把命中的 `https` 请求在发往网络之前改写成
> 自定义 scheme，再由 `register_uri_scheme` 从本地密文回放。**这条路本文不背书** ——
> 跨源（https → 自定义 scheme）的 CORS / secure-context 语义、子资源与媒体元素的接受度、
> 以及"我们的原生代码进渲染进程"这一信任边界变化，三件都没有验证，而且第一件可能根本立不住。
> 记在这里是为了说明：**连那条理论路径也不在 Tauri 的公开 API 里**。

### 2.4 Tauri 自己的下载钩子（实测文档，非传闻）

Tauri `2.12.2` 的 `webview::DownloadEvent`：

```rust
pub enum DownloadEvent<'a> {
    Requested { url: Url, destination: &'a mut PathBuf },  // 可改保存路径（须绝对路径）
    Finished  { url: Url, path: Option<PathBuf>, success: bool },
}
```

即：**能改保存路径**（这一点比预期好），但**没有 MIME、没有文件名、没有总字节数、没有取消句柄**。
对照 [ADR-0047](../decisions.md#adr-0047) 与 `capture/download.ts` 的现状：

- "超大文件不接管（>4 GB 回落原生）"依赖下载**开始前**的总字节数 ⇒ 拿不到。
- "命中归档就 `item.cancel()` 作废这次下载"（H1 短路）⇒ 没有取消能力，只能退化成
  "让它下完、再按哈希去重"（也就是 ADR-0047 之前的行为）。
- MIME 是索引里的一个字段、也是回落行为的一部分 ⇒ 只能靠 URL/响应头自己猜。

**结论**：接管点 A 可以"重建到能用"，但**明确不是对等**；接管点 B 在 WebKitGTK 上没有可用的
实现路径（§2.3 第 2 行）。

### 2.5 直通重发的会话一致性（容易被忽略的一堵墙）

现在的直通是 `ses.fetch` —— 它 **在同一个分区会话里**发请求，所以 cookie 罐、代理/证书配置、
连接池都与页面一致（[ADR-0033](../decisions.md#adr-0033) 记着实测过的退化：用别的会话重发，
响应的 `Set-Cookie` 会进错罐子，登录态长期陈旧）。

Tauri / Wails 的后端 HTTP 客户端（reqwest / Go `net/http`）与 webview 的会话**天然是两套**；
要共用一个 SoupSession 得下沉到 GLib 层，而那一层不在 Tauri 的抽象里。
**也就是说：即使绕过上面所有问题，直通路径也会重新引入 ADR-0033 已经实测排除的那个失效模式。**

---

## 3. 逐方案评估

每个方案给出：适用场景 / 主要阻碍 / 若真要走的迁移路径 / 功能对等验证要点。

### 3.1 A · 保持 Electron（现状 + 边角裁剪）

**适用场景**：本项目的现状就是它的最优场景 —— Linux 单平台、一个网页版承载、两个内核层接管点、
用户接受 100 MB 量级的安装包。

**可做的优化**（都属于"收益有限但零风险"的一类，**均未实测**）：

- `electronLanguages` 裁掉不用的语言包（本地 `locales/` 8.7 MB）；
- 评估 `libvk_swiftshader.so`（4.5 MB）与 `libffmpeg.so` 是否必须随包；
- 延迟创建两扇本地界面窗口（现在启动时三扇一起建）；
- 用 `--js-flags=--max-old-space-size=...` 之类收紧堆上限（**只在实测有收益时才做**）。

**阻碍**：无。**代价**：283 MB 的 Chromium 分发与每次 Electron 大版本升级的核对工作量照旧。

**迁移路径**：不需要。若做裁剪，按 `docs/packaging.md` + `pnpm run verify` 的现有纪律走。

### 3.2 B · Tauri v2（Linux = WebKitGTK）

**适用场景**：新写的、UI 驱动的、**不依赖内核网络栈**的桌面应用；对体积极敏感；愿意接受
"Linux 上渲染引擎是发行版给的"。

**主要阻碍**（按致命度排序）：

1. **接管点 B 消失**（§2.3）。密文缓存 = 项目的一半价值（M3 的全部内容）。
2. **接管点 A 只能部分重建**（§2.4）。
3. **登录态无法迁移**：Chromium profile ≠ WebKitGTK profile ⇒ 全体用户重新扫码。
4. **账号分层退化**：`account.ts` 读 Chromium LevelDB（`src/main/account.ts:125`）失效 ⇒
   归档退到 `unknown-account`。
5. **引擎版本不可控**：页面兼容性变成发行版 WebKitGTK 版本的函数（Ubuntu 24.04 / 26.04 /
   Fedora / Flatpak 各一个），而"上游改版 + 引擎版本漂移"是两类**不可归因**的故障叠在一起。
6. **UA 只能谎报**：Chrome UA + WebKit 内核 ⇒ 页面会走 Chrome 的代码路径，而引擎不提供对应能力
   （WebCodecs / 编解码 / WebRTC 细节），失效方式是**静默**的。反过来用 Safari UA 则进 Safari 路径，
   上游那条路径的成熟度不受我们控制。
7. **归档层重写**：2481 行 + FTS5（Rust `rusqlite` 需确认 FTS5 编译开关）。
8. 打包/发布链路整体重建：`electron-builder` → `tauri build`；ADR-0013 / ADR-0014 /
   `syncDesktopName` / `StartupWMClass` / AppArmor / `SHA256SUMS` / `electron-updater` 全部作废重做。
9. 生态：Tauri v2 的官方插件（tray / notification / autostart / single-instance / opener / updater）
   覆盖了本项目所需的大部分，但**没有**下载接管、**没有**协议拦截。

**迁移路径（若强行要走）**：
先做 §7.0 的"一日否决试验"（WebKitGTK 能不能打开并登录网页版、点开一个文档、发一条语音）。
试验通过才进入：Tauri 骨架 → 归档层 Rust 重写（以现有 TS 为规格、移植单测）→ 接管点 A 用
`DownloadEvent` 重建（放弃 H1 短路与超大文件预判）→ **接管点 B 降级为"关闭"或"仅直通"** →
打包与发布链路重建 → 全量验收。
**第 4 步意味着要显式删掉一个已实现、已被 M3 验收的功能** —— 这是该方案真正的价格。

**功能对等验证要点**：见 §7.1（把 roadmap M1–M3 的验收 + §7.2 的平台矩阵一起跑）。

### 3.3 C · Wails v2/v3（Linux = WebKitGTK，后端 Go）

**与 B 的关系**：**同一堵墙**（WebKitGTK），差别只在后端语言与绑定方式。

**额外的劣势**：

- 后端换成 **Go**：`src/main/` 的 8.4k 行要按 Go 重写；`better-sqlite3` → Go 的 SQLite 绑定，
  FTS5 在 Go 侧通常要靠构建标签（`mattn/go-sqlite3` 的 `sqlite_fts5`）或换 `modernc.org/sqlite`，
  **跨发行版/交叉编译下 FTS5 的可用性要单独验证**。
- 前端到后端的绑定默认**把已绑定的方法全部暴露**给前端（不区分窗口），比 Tauri v2 的
  capabilities/ACL 弱 —— 对本项目"远程内容绝不能触达本地能力"的判据（T6 / T1）是**退步**，
  需要自己加一层白名单与来源校验。
- **成熟度**：v2 稳定；**v3 于 2026-08-02 才发布 Beta**（三年重写）。选 v3 = 把产品的运行时
  押在一个刚进 Beta 的框架上；选 v2 = 用它的旧窗口模型。两者都不比现状好。
- 没有内建自动更新；托盘/通知/自启要自己接或找第三方。

**结论**：在 B 已经否决的前提下，C 没有任何独有优势。**否决。**

### 3.4 D · Tauri + CEF（Chromium 后端）

**这是唯一能保住 Chromium 语义的 Tauri 路线**：Tauri 生态里存在以 CEF 为后端的构建方式
（CLI fork + `--features cef`，目前属实验/alpha 通道），公开的先例是一个开源阅读器把 Linux 的
**所有发行渠道**（含 Flathub）都切到 CEF、并清理掉了 WebKitGTK 时代的 UA 探测与特性豁免。

**它保住什么**：CEF 提供 `CefResourceRequestHandler`（可拦截请求并**合成响应**）与
`CefDownloadHandler`（下载事件 + 指定保存路径 + 取消）⇒ 两个接管点**理论上有对等实现**。

**代价**：

1. **体积回到同量级**：CEF 是完整的 Chromium 发行包（`libcef` + 资源），**"小体积"这个唯一的
   主要收益消失**（具体兆数必须实测，本文不下结论）。
2. **走的是 fork / alpha 路径**：CLI 与底层工具持续变动，版本要自己钉；
   这是"上游随时可能变"的第三处来源（另两处是 Electron 与网页版本身）。
3. **要写 CEF 胶水**（Rust `cef-rs` 一类），生态成熟度远低于 Electron 的 `session` / `protocol` API。
4. 后端仍是 Rust ⇒ 归档层仍要重写；打包/发布/自动更新链路仍要重建。

**因此 D 的净收益只剩"Rust 后端 + Tauri 的权限模型"**，而净代价是"CEF 胶水 + fork 依赖 +
链路重建"。**只有在 A 被外部条件推翻（例如 Electron 停止维护、或 Chromium 移除
下载事件 / `protocol.handle`）时，才值得启动。**

### 3.5 E · 其它方案（逐条否决）

| 方案 | 否决理由 |
|---|---|
| **NW.js** | 同为 Chromium 承载，能力面与 Electron 重叠；生态与维护活跃度不如 Electron；换过去只换来一次全量回归 |
| **直接用 CEF**（C++ / 各语言绑定） | 等于自己写一个 Electron：进程模型、IPC、托盘、打包全自己做；没有收益，只是把 Electron 换成一个更不成熟的同类 |
| **Electron 之外再挂一份独立 Chromium**（puppeteer / Playwright 路线） | [ADR-0043](../decisions.md#adr-0043) / [ADR-0044](../decisions.md#adr-0044) 走过的路，已由 [ADR-0057](../decisions.md#adr-0057) 放弃（INV-1 / INV-2 恢复），且那份调研（[browser-runtime-assessment.md](browser-runtime-assessment.md)）已论证它**不省任何东西** |
| **系统 Chrome/Chromium 以 `--app=` 方式承载 + 本地代理做缓存** | 两处致命：① 代理要看到 `https` 明文就得 **TLS 中间人**，直接违反 [INV-3](../decisions.md#adr-0007)（也违反 INV-1 的实质）；② `--remote-debugging-port` / CDP 驱动页面已被 [ADR-0057](../decisions.md#adr-0057) 否决。**这条路不是"另一个架构"，是绕过不变量** |
| **系统 Chrome + 只做下载事件**（`--app` 模式 + 文件系统监视） | 拿不到 MIME / 文件名 / 归档时机，且依赖"用户装了 Chrome"这个与本项目 AppImage 分发冲突的前提（[browser-runtime-assessment.md](browser-runtime-assessment.md) §3 方案 B 已被否决的同一个理由） |
| **Neutralino / Deno desktop 等新壳** | 同样是系统 webview（Linux = WebKitGTK），撞同一堵墙；生态更小 |
| **把归档层做成 Node sidecar、只换 UI 壳（WebKitGTK）** | 解决不了核心问题（接管点 B 仍无实现），却多出一个 Node 运行时 ⇒ 体积回到同量级而能力下降 |

---

## 4. 六个维度的对比

| 维度 | A · Electron（现状） | B · Tauri v2（WebKitGTK） | C · Wails（WebKitGTK） | D · Tauri + CEF |
|---|---|---|---|---|
| **启动速度** | 实测 1.02 s 到 `ready` | 公开说法更快（省掉 Chromium 初始化）；**未实测**。真实值取决于系统 WebKitGTK 初始化 + 进程模型 | 同 B | 与 A 同量级（仍要初始化 Chromium） |
| **内存** | 实测进程树 RSS 合计 ≈ 1.13 GB（**含共享页重复计数**，实际更低；需 PSS） | 公开说法更低（无自带渲染进程）；**未实测**。但 WebKitGTK 也是多进程 + 也要跑页面本身 | 同 B | 与 A 同量级 |
| **包体积** | 实测 283 MB 解包（deb / AppImage 具体兆数**未测**：`dist/` 为空） | 个位数 MB **+ 系统 WebKitGTK**（对 AppImage 意味着"依赖宿主发行版的库版本"） | 同 B | **回到同量级**（CEF 是完整 Chromium） |
| **安全模型** | Chromium 多进程沙箱 + `sandbox: true` + 承载窗口**不挂 preload** + IPC 来源校验 + AppArmor profile（ADR-0043 前已实测）；本项目 T1–T7 整套威胁模型都建立在这上面 | WebKitGTK 的进程隔离与沙箱强度**弱于 Chromium**，且随发行版版本变化；Tauri v2 的 **capabilities/ACL（按窗口限制可调用的命令）比 Electron 现状更细** —— 这是 B 唯一明确优于 A 的一点；代价是"远程页面触达本地能力"这条主线要靠 ACL 重新论证一遍 | 绑定方法默认对前端全开放（分窗口粒度弱）；要自己补白名单 | 与 A 同量级（CEF 的进程模型与 Electron 同源） |
| **跨平台与系统集成** | 只有 Linux（产品决定）；deb + AppImage + AppArmor + 托盘 + app_id/`.desktop` 对齐，全部已实现并**有产物断言**（`scripts/verify-package.sh`） | 跨平台是它的卖点，但**本项目不跨平台 ⇒ 收益为零**；而 Linux 恰是它最弱的一环。系统集成要按宿主插件重写，且**"构建全绿、运行时静默失效"那一整类坑（ADR-0020 / ADR-0022 / packaging.md 第 2 节）要重新踩一遍** | 3.2 的同等代价 + 自启/更新要自己写 | 与 B 相同的集成重写代价，但没有 webview 能力缺口 |
| **开发体验 / 迁移成本** | 0（现状）。语言与工具链已定：TS + electron-vite + vitest（404 个用例） | 后端换成 Rust：`src/main/` 8.4k 行重写（含 2481 行归档 + FTS5）；`renderer/`（791 行）与 `shared/`（1780 行）大体可留；测试"留得下、被测代码留不下"。构建链路（electron-vite → cargo/tauri CLI）、打包（electron-builder → tauri bundle）、发布（bumpp + electron-updater → tauri updater + 签名密钥）**全部重建** | 后端换 Go，重写面与 B 相同；绑定生成 + 手写白名单 | 重写面同 B，另加 CEF 胶水与 fork 工具链 |
| **生态成熟度** | Chromium + Electron 的 `session` / `protocol` / 下载管理器是**十年级**的 API，文档与先例充足；本仓库围绕它写了 59 条 ADR | 框架本身成熟（v2 稳定、插件齐），但**缺的恰好是我们要的两块**（下载接管只有半套、协议拦截没有）；WebKitGTK 侧的社区样本远少于 Chromium 侧 | v3 刚 Beta；CEF/下载/更新类需求多要自己写 | CEF 本身成熟，**Rust 侧绑定与 Tauri 的 CEF 集成不成熟**（alpha/实验通道） |
| **长期维护风险** | ① 跟随 Electron 大版本的核对工作量（`dependabot.yml` 已把主版本升级列为人工评审项）；② Chromium 若移除 `will-download` / `protocol.handle`（可能性低但非零）⇒ 核心机制要重做；③ 283 MB 分发体积长期存在 | ① **引擎版本不可控**（发行版决定）；② 上游改版 + 引擎漂移两个不可归因变量叠加；③ 需要**显式承认功能回退**（接管点 B 无法保留）；④ 每次想升级内核 = 换发行版基线（或改走 D 的 CEF） | 同 B，外加框架自身从 v3 Beta 走向稳定的不确定性 | ① fork / alpha 工具链的持续变动；② CEF 版本与网页版兼容要自己跟；③ 体积回退 ⇒ 迁移的主要理由消失 |

---

## 5. 与既有决策的关系（迁移会撞到哪些已生效的 ADR）

| 撞到的东西 | 为什么 |
|---|---|
| [ADR-0001](../decisions.md#adr-0001)（Chromium 内核壳 + 内核层接管） | 换宿主 = 换内核；B/C 直接推翻它 |
| [ADR-0033](../decisions.md#adr-0033)（直通发回分区会话） | Tauri/Wails 的后端 HTTP 客户端与 webview 会话是两套（§2.5） |
| [ADR-0013](../decisions.md#adr-0013) / [ADR-0014](../decisions.md#adr-0014)（Release 与发布说明机制） | 发布链路由 electron-builder + electron-updater 的具体行为定义，换宿主即作废 |
| [ADR-0020](../decisions.md#adr-0020) / [ADR-0022](../decisions.md#adr-0022) / [ADR-0032](../decisions.md#adr-0032)（身份与图标三层落点） | 桌面集成要按新宿主重新对齐，且**必须重新建断言**，否则退回"构建全绿、运行时静默失效" |
| [ADR-0057](../decisions.md#adr-0057)（INV-1 恢复 + 只读例外） | 例外的实现是 `executeJavaScript`；Tauri 有 `eval` 但对等语义要自建回传通道（可迁移，但调用点与新内核的失效模式要重新实测） |
| [browser-runtime-assessment.md](browser-runtime-assessment.md) §3 方案 B | "引擎版本取决于发行版"这条**已经被评估过并否决过一次**；B/C 就是它的重演（那次否决的目标是"用系统浏览器"，这次是"用系统 webview"，判据同构） |

---

## 6. 建议

### 6.1 结论：不迁移，保持 Electron

按权重排序的理由：

1. **迁移会删掉核心功能，而不是换个实现方式。** 接管点 B（二次打开零网络）的实现机制
   `protocol.handle('https')` 在 WebKitGTK 上没有对等物（§2.3）；接管点 A 只能重建出**更弱**的
   版本（丢 H1 短路与超大文件预判，§2.4）。M3 是当前里程碑里唯一"代码已实现、只差端到端验收"
   的一块 —— 迁移等于把它砍掉。
2. **目标平台就是 Linux，而 Linux 恰好是 Tauri/Wails 最弱的一格。** 跨平台收益为零，
   却要落在 WebKitGTK 上。
3. **引擎版本失控是结构性的，不是可以靠改代码解决的。** 本项目的全部脆弱点来自"上游网页版会变"，
   架构上已有一条纪律："允许失效，不允许静默失效"（`architecture.md` 第 5 节）。
   把引擎版本也交给发行版，会让"接管失效"与"页面本身打不开"这两类故障在用户机器上**合并成
   同一个症状**（白屏 / 点不动），直接摧毁这条纪律的可诊断性。
4. **重写面与收益不对称**：8.4k 行主进程（其中 2481 行是最要命的归档层）+ 两套构建/发布链路，
   换回来的是"内存可能低一点、体积小一点、Rust 的 ACL 更细"。
5. **唯一能保住能力的岔路（D · Tauri + CEF）把主要收益还了回去**：体积回到同量级，
   另加 fork/alpha 依赖与 CEF 胶水。

**建议改做的事**（都在现状内，风险为零）：

- 把 §1.4 的测量**固化成脚本**（`scripts/` 里一条 `measure` 任务），这样才能在将来回答
  "升级 Electron 之后启动/内存变化了多少"；
- 评估 §3.1 的边角裁剪（语言包 / 软渲染 / 延迟建窗），**逐项实测后再决定**；
- 若所有者希望"不迁移"成为一个**正式决定**（而非一份评估），在 `docs/decisions.md` 追加一条 ADR
  （本文只给建议，不代替那个决定）。

### 6.2 什么情况下应当重启这个问题

写下来，免得将来重新发明：

| 触发条件 | 那时该评估什么 |
|---|---|
| Chromium 移除 `will-download` 或 `session.protocol.handle`（或将其降为不受支持的内部 API） | D（Tauri + CEF）或"退回上游原生下载 + 放弃缓存层" |
| Electron 停止维护 / 长期无安全更新 | 先看 **CEF 直接承载**，再看 D |
| 产品目标平台扩到 Windows / macOS（现在是"明确不做"） | Tauri / Wails 的跨平台账**才第一次成立**，但仍要先解决接管点 B；Windows 的 WebView2 仍是 Chromium，可能只需要 `WebResourceRequested` 的等价改写 |
| 分发体积成为**实际阻塞**（用户投诉 / 商店上限 / CI 时间） | 先做 §3.1 的裁剪；不够再评估 D（届时 CEF 的体积必须实测） |
| 上游网页版彻底不再需要"点击触发下载"这一形态 | 那时本项目的主要功能前提变了，应重新评估产品本身，而不是换宿主 |

**不建议的路径**（已在上文逐条给出理由，这里汇总以便拦住"看起来更省事的办法"）：
本地代理做 TLS 中间人（违 INV-3）、CDP 驱动系统 Chrome（违 ADR-0057）、
再引一份独立 Chromium（ADR-0044 已否决）、把归档层做成 Node sidecar 只换 UI 壳。

---

## 7. 验证要点

### 7.0 任何迁移之前的"一日否决试验"（成本：一个工作日）

本机现在连 Tauri 都跑不起来（§1.4），所以第一步不是写代码，而是**回答页面能不能用**：

1. 装一个 WebKitGTK 浏览器（如 `epiphany-browser`）或建一个 Tauri hello-world；
2. 打开 `web.whatsapp.com`：能加载吗？能扫码连接吗？**断开重连后会话还在吗**（IndexedDB 持久化）？
3. 发一条语音消息、点开一个文档（触发下载）、试一次语音通话（WebRTC + 麦克风权限）；
4. 记录 WebKitGTK 版本，并在**至少两个发行版基线**（Ubuntu 24.04 / 26.04）上重复第 2、3 步。

**第 2 或第 3 步不通过 ⇒ 立刻停止，本文的其余部分不必执行**（这正好是 §2.2 与 §2.5 的实测版）。

### 7.1 功能对等验收清单（以现有实现为基准）

| # | 断言 | 依据 |
|---|---|---|
| 1 | 聊天里点一个文档 ⇒ 系统默认应用直接打开，`~/Downloads` 里**没有**该文件 | roadmap M1 |
| 2 | 归档目录出现该文件、索引有记录、且索引里的记录在磁盘上**全部存在**（无悬空记录） | roadmap M1 / ADR-0048 |
| 3 | 同一文件转发到另一会话后再点：归档**文件数不增加**（哈希命中 / 硬链接） | roadmap M1 / ADR-0031 / ADR-0055 |
| 4 | 超大文件（> 上限）**回落原生行为**并留下可见记录 | `capture/download.ts:97` / ADR-0047 |
| 5 | 二次打开同一文件：**断网仍能打开**；期间**没有**新的 CDN 请求（抓包或连接观察） | roadmap M3（当前未验收） |
| 6 | 三种媒体类型（图片 / 视频 / 文档）的缓存键稳定性**分别实测** | roadmap M3 |
| 7 | 关掉密文缓存开关后，行为与 M1 **完全一致**；切换是事务式的（失败回退） | ADR-0027 / ADR-0049 |
| 8 | 缓存超上限时**退化为直通**（请求照常完成、不报错），只删 `.bin` / `.meta.json` | ADR-0049 |
| 9 | 权限白名单仍是五项、来源判据仍是 **origin 精确比对**；屏幕共享走系统选择器 | T5 / ADR-0035 / `session.ts:58` |
| 10 | UA 不含嵌入式运行时标记（`Electron` / 项目名），**且与实际内核能力一致** | `shared/user-agent.ts` + 本评估新增的一条 |
| 11 | 账号 / 会话分层仍生效；拿不到时回落 `unknown-account` / `unknown-chat`，**不阻断落盘** | ADR-0039 / ADR-0055 |
| 12 | 接管失效时**有明确提示**（每种原因一次），不允许静默退回原生下载 | ADR-0042 / `architecture.md` 第 5 节 |
| 13 | 落盘权限：归档 `0700`、正文 `0400`、索引随归档目录、缓存根独立 | `security.md` 资产表 |
| 14 | 桌面集成：`.desktop` 文件名 == `app_id`、`StartupWMClass` == `app_id`、三层图标、托盘、单实例、关闭=隐藏、Ctrl+Q 退出、开机自启 | ADR-0020 / ADR-0022 / `verify-package.sh` |
| 15 | 沙箱：deb 装完能起、AppImage 在**未装 libfuse2** 的系统上能起、非特权 user namespace 受限时仍有指引 | packaging.md |
| 16 | 不变量：ESLint 守卫生效、`selfcheck` 第 15 节绿、产物里不出现非例外的注入面 | INV-1/2/3 |
| 17 | 打包与发布：解包断言通过、Release 非草稿且四个产物齐全、**自动更新真的能升一次** | ADR-0013 / ADR-0014 |
| 18 | 日志脱敏：不含文件名全文、会话名、绝对路径中的用户名、任何 token | T4 |

**新增、且只对 WebKit 宿主成立的维度**（这是迁移特有的风险面）：

| # | 断言 |
|---|---|
| 19 | 在**至少两个发行版基线**（Ubuntu 24.04 / 26.04）与 Flatpak 运行时上，第 1–5 条全部通过 |
| 20 | 记录引擎版本（WebKitGTK `x.y.z`），并确认**同一份产物**在这些基线上行为一致 |
| 21 | 若采用自定义 scheme 回放（§2.3 的理论路径）：跨源语义、媒体元素接受度、以及"我们的原生代码运行在渲染进程侧"这一边界变化**各有实测证据 + 一条 ADR** |

### 7.2 迁移对照的底线纪律

- 任一"接管能力缺失"必须**写成 ADR**：允许失效，不允许静默失效（`architecture.md` 第 5 节）。
- 任何放宽 INV-1 / INV-2 / INV-3 的念头（例如为了省事改用代理或 CDP）→ **停下提问**
  （`AGENTS.md` 第 6 节）。

---

## 8. 本文的局限

1. **Tauri / Wails / CEF 一个都没实测**。它们的所有数值与行为结论都来自公开文档与公开案例，
   不是本仓库的测量结果（本机没有 Rust 工具链、没有 webkit2gtk 开发头文件、没有 WebKitGTK 浏览器，
   §1.4）。§7.0 的试验就是为补上这一段而写的。
2. **性能数字的采集方式有已知偏差**：`ready` 不是"页面可用"；RSS 求和重复计算共享页；
   Xvfb 下退到软渲染。要做严肃对比，需改用 PSS + 联网 + 真实登录态。
3. **WebKitGTK 的能力判定取自官方 API 参考**（`WebKitDownload` / `WebKitWebContext` /
   `WebKitWebPage::send-request`，文档版本 2.42.5 系列）。它在更新版本上可能变化 ——
   这些页面上没有 `since` 标注的部分应按"当前实现"而非"永久承诺"读。
4. **Tauri 侧的事实取自 `DownloadEvent` 的 `2.12.2` 文档**（2026-10-09）；它是 `#[non_exhaustive]`，
   变体可能增加（"取消下载"这类能力将来可能补上）—— 那会改变 §2.4 的结论，但**不改变 §2.3**
   （协议拦截是内核能力，不是框架补得上的）。
5. **体积对比只有 Electron 一侧有数字**（283 MB 解包）；deb / AppImage 的具体大小必须
   `pnpm run pack` 实测（当前 `dist/` 为空）。
6. 本文回答的是"**换宿主**"。它不回答"**要不要把归档层抽出来做成独立进程/服务**"——
   那是另一个问题，另开一份文档（`docs/README.md` 第 6 节的写作约定）。
