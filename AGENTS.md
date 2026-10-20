# AGENTS.md

给在此仓库中工作的 AI 编码助手的入口文件。**动手改任何东西之前，先完整读完本文件。**

人类贡献者请从 [`CONTRIBUTING.md`](CONTRIBUTING.md) 开始。

---

## 0. 这个项目是什么

WaaChat 是一个 Linux 桌面聊天客户端：**Electron 承载官方网页版**，在浏览器内核层接管下载与网络；归档层在这一层之上把文件按内容哈希落盘，避免重复占用、避免链接过期后打不开。

**一句话判据**：我们交付的是「一个由网页版能力驱动的桌面客户端」—— Electron 承载官方网页版，在浏览器内核层接管「下载文件」这一个动作。INV-1 / INV-2 曾被 [ADR-0043](docs/decisions.md#adr-0043) 撤销，现已由 [ADR-0057](docs/decisions.md#adr-0057) **恢复**：现行边界是全部四条硬约束（INV-1 附带一条只读元数据例外；它曾经还有一条"写上游那条语言偏好 cookie"的写入例外，已由 [ADR-0066](docs/decisions.md#adr-0066) 撤销）。引入 `whatsapp-web.js` 那条路线**已经放弃**。

## 1. 硬约束（先读这个，再读别的）

四条**全部不可协商**（违反的改动必须被拒绝，而不是讨论）。其中 INV-1 与 INV-2 曾被 [ADR-0043](docs/decisions.md#adr-0043) 撤销，现已由 [ADR-0057](docs/decisions.md#adr-0057) 恢复。

<!-- 与 ai/INVARIANTS.md 保持同步 -->

| 编号 | 约束 | 一句话理由 |
|---|---|---|
| **INV-1** | **绝不向被承载的页面注入脚本**（附一条**只读元数据例外**，见 `ai/INVARIANTS.md`，[ADR-0057](docs/decisions.md#adr-0057)）。不通过 CDP 驱动页面、不注入样式、不引入 puppeteer 家族 / `whatsapp-web.js` / `wwebjs-electron`。⚠️ 它曾经还有一条"按用户显式选择写下上游那条语言偏好 cookie"的**写入例外**（[ADR-0065](docs/decisions.md#adr-0065)），**已由 [ADR-0066](docs/decisions.md#adr-0066) 撤销**（实测：页面会在几秒内按账号语言把它改回去）。 | 立身之本是「页面逐字节等同官方网页版」；那条例外削弱了这条强表述，但「不主动注入、不给远程内容本地能力」这条实质不变 —— 见 [ADR-0057](docs/decisions.md#adr-0057) 与 [ADR-0066](docs/decisions.md#adr-0066) |
| **INV-2** | **绝不重实现传输协议**：不引入 whatsmeow / Baileys / WPPConnect / Venom 之类协议库，不自行实现握手、密钥协商与消息编解码。 | 协议级客户端是被重点识别的一类，能力缺口是结构性的；这条与承载方式无关，因此没有理由放弃 —— 见 `docs/decisions.md` ADR-0001 / ADR-0057 |
| **INV-3** | **绝不经手密钥与加密。** 不解析 mediaKey、不修改加密流量、不做自己的解密实现。解密只由官方页面代码完成。 | 触碰加密会把项目从「宿主」变成「破解工具」，性质完全不同 |
| **INV-4** | **绝不使用服务方的视觉标识资产。** 不用 WhatsApp / Meta 的 Logo、图标、字体、吉祥物、官方配色，也不用其素材做应用图标。项目名 `WaaChat` 不含服务方名称，但强制义务不变：非官方声明必须同时出现在 `README.md`、`DISCLAIMER.md` 与安装产物中。 | 名称与知名服务近似，而应用承载的正是那个服务——声明义务是"不做官方外观"之外的第二道防线；视觉资产则成本为零、风险最高，因此始终是红线 —— 见 `docs/decisions.md` ADR-0020 |

**ESLint 强制 INV-1 / INV-2 / INV-3**：`eslint.config.mjs` 的 `projectGuards`（作用于 `src/**`）把三组规则
合并发出 —— INV-1 禁 `executeJavaScript` / `executeJavaScriptInIsolatedWorld` / `insertCSS`，INV-2 禁 puppeteer
家族 / `whatsapp-web.js` / `wwebjs-electron` 与 `*/baileys` 等协议库，INV-3 禁解密原语
（`createDecipher*` / `createCipher*` / `createHmac` / `hkdf` / `subtle`）与密钥字段（`mediaKey` / `filehash`）。
**INV-1 的只读例外**在调用点用行内 `eslint-disable-next-line no-restricted-syntax` 显式声明（当前两处：
`capture/download.ts`、`dev-probe.ts`，见 [ADR-0057](docs/decisions.md#adr-0057)）。
`pnpm run selfcheck` 第 15 节再加一道 INV-3 的文本扫描，并断言依赖里没有在 Node 侧解密的库。
第 19 节另有一条**负向回归断言**：`src/` 里不出现 `cookies.set(` / `cookies.remove(` —— 被 [ADR-0066](docs/decisions.md#adr-0066)
撤销的写入例外不许悄悄回来（`eslint.config.mjs` 只禁**注入类** API，管不到"写 cookie"）。

渲染侧的**进程边界**（G-1）：渲染进程仍不得 import `electron` / `node:fs` / `node:path`，仍由 ESLint 强制。

要改任何一条守卫：不要直接改 lint 配置，先在 `docs/decisions.md` 里追加一条 ADR 并说明理由。

## 2. 常用命令

**唯一入口是 `package.json` 的 `scripts`。** 这里没有 Taskfile、没有 Makefile —— 要加一个多步任务就往 `scripts` 里加一条，不要在文档里发明一条别人跑不了的命令。

```bash
pnpm install             # 装依赖（postinstall 跑 install-electron 拉 Electron 二进制）
pnpm run dev             # 开发模式（热重载）
pnpm run build           # 类型检查 + 编译 main/preload/renderer 到 out/

pnpm run check           # lint + 格式 + 类型检查 + 单测 + 接管自检（提交前必跑 = CI 的 PR 任务）
pnpm run verify          # 构建 deb + AppImage，然后解包实测（改打包/桌面集成时必跑）
pnpm run ci              # check + verify（本地复现 CI 全流程）

pnpm run release         # 发版：bumpp 提升版本 → 提交 → 打 v<版本> 标签 → 推送（触发发布工作流，不可回退）
pnpm run release --release minor   # 同上，但直接指定版本类型或版本号；再加 --yes 可全非交互
                         # ⚠️ 不要写成 `pnpm run release -- --release minor`，见第 5 节坑表

pnpm run pack            # 只打包，不校验
pnpm run pack:deb        # 只出 deb
pnpm run pack:appimage   # 只出 AppImage
pnpm run pack:dir        # 只出解包目录（排查产物内容时最快）
pnpm run verify:package  # 只跑产物校验（dist/ 已有产物时用）

pnpm run test            # 单测（一次）
pnpm run test:watch      # 单测 watch
pnpm run selfcheck       # 只跑离线接管自检（缓存键推导 / UA / 目录权限）
pnpm run icons           # 改了 build/icon.svg 之后重新生成 PNG
pnpm run clean           # 清理 out/ dist/ coverage/ node_modules/.vite/ .tmp/
```

`pnpm run pack:publish` 会真的上传到 GitHub Release，**只在 release workflow 里用**；本地所有打包脚本都带 `--publish never`。

`pnpm run check` 里的「接管自检」是 `scripts/check-capture.ts`：不联网、不启动 Electron，
只验证几条关键约定还成立（缓存键推导、UA 是否干净、归档目录权限）。上游改版后它通常最先变红。

## 3. 文档路由

先看这张表，再决定读哪份文档。**不要靠猜。**

| 你要做的事 | 读这个 |
|---|---|
| 了解整体设计、数据流、模块边界 | [`docs/architecture.md`](docs/architecture.md) |
| 搞清楚某个设计**为什么**是这样 | [`docs/decisions.md`](docs/decisions.md) ← **唯一事实源** |
| 改打包、桌面集成、发布流程 | [`docs/packaging.md`](docs/packaging.md) |
| 改下载接管 / 缓存逻辑 | [`docs/media-capture.md`](docs/media-capture.md) + [`ai/INVARIANTS.md`](ai/INVARIANTS.md) |
| 查术语、理解领域概念 | [`ai/CONTEXT.md`](ai/CONTEXT.md) |
| 写代码前确认风格与规范 | [`ai/CONVENTIONS.md`](ai/CONVENTIONS.md) |
| 做一件具体的常见任务 | [`ai/TASKS.md`](ai/TASKS.md)（分步操作手册） |
| 触碰安全 / 隐私 / 合规相关的代码 | [`DISCLAIMER.md`](DISCLAIMER.md) + [`docs/security.md`](docs/security.md) |

**文档的一致性责任**：`docs/decisions.md` 是唯一事实源，其余文档都是它的展开。若你发现两份文档冲突，以 `docs/decisions.md` 为准，并在**同一个 PR** 里修正另一份。

## 4. 改动前自检

任何提交之前，逐条确认：

- [ ] 没有触碰第 1 节的四条硬约束（`pnpm run check` 会替你挡一部分）
- [ ] `pnpm run check` 通过
- [ ] 若动了打包配置、`.desktop`、图标或权限：`pnpm run verify` 通过
- [ ] 若这是一个**设计选择**（选型、取舍、放弃某方案）：已在 `docs/decisions.md` 追加 ADR，而不是只写在 commit message 里
- [ ] 若改了 `docs/` 里的内容：对应的 `ai/` 文档已在同一 PR 同步（反之亦然）
- [ ] 没有引入新的原生依赖——**除非**在 ADR 里说明了它对 AppImage / deb 打包的影响
- [ ] commit message 遵循 `ai/CONVENTIONS.md` 的格式

## 5. 已知的坑（省你一次踩）

| 坑 | 说明 |
|---|---|
| **必须用 pnpm ≥ 12，不能用 npm** | 锁文件是 `pnpm-lock.yaml`，版本由 `packageManager` 钉死。低于 12 的 pnpm 不认 `pnpm-workspace.yaml` 里的 `allowBuilds`，`esbuild` 的构建脚本会被拦下 → 构建失败。见 ADR-0010。 |
| **依赖的构建脚本白名单在 `pnpm-workspace.yaml`，不在 `.npmrc`** | pnpm 12 起 `allowBuilds` 属于那个文件。写进 `.npmrc` 会被当成未知配置**静默忽略**，症状是某个包「装上了但没构建」。 |
| **不要定义名为 `install` 的 script** | 它与包管理器的生命周期钩子同名，`pnpm install` 会递归调用自己。装依赖就是 `pnpm install`，不需要包装。 |
| `typescript` **必须锁在 6.0.x** | `typescript-eslint` 的 peer 要求 `<6.1.0`。升级 TS 到 7.x 会直接装不上，别顺手 `pnpm update`。 |
| `vite` **必须留在 7.x** | `electron-vite@5` 的 peer 是 `^5 \|\| ^6 \|\| ^7`，而 vite 已经有 8.x。装 8 会让 `pnpm install --frozen-lockfile` 直接 ERESOLVE 失败（不是运行期问题，是装不上）。`dependabot.yml` 已忽略 vite 的主版本升级。 |
| `bumpp` 的主版本与 `.nvmrc` 绑定 | 发布命令（`pnpm run release`）由它执行。12.x 的 `engines` 是 `^22.18.0 \|\| ^24.11.0 \|\| >=26.0.0`，而 `.nvmrc` 是 24.21.0：**下调 `.nvmrc` 会让发布命令直接跑不起来**，CI 的 `pnpm install` 也会报引擎不符。理由见 `docs/decisions.md` ADR-0012。 |
| `bump.config.ts` 的 `files` 里**不要**加 `CHANGELOG.md` | bumpp 对非"已知文件"做的是**旧版本号全文替换**，会改写 CHANGELOG 里的历史小节与既有链接，而且不报错。 |
| **给 `pnpm run <script>` 传参数不要写 `--`** | pnpm 12.10.1 把 `--` **原样转发**给脚本（实测 `pnpm run release -- --help` 的命令回显是 `$ bumpp -- --help`），而 bumpp 只解析「脚本名之后的裸参数」：带 `--` 时那些 flag 会落到它的**位置参数（文件名）**上 —— 版本参数不生效、弹出交互式版本选择器，最后还会去 bump 一个叫 `--release` 的文件。正确写法是 `pnpm run release --release minor`（非交互再加 `--yes`）。 |
| **Electron 二进制不由 `electron` 包自己下载** | Electron 44 已删掉自身的 `postinstall`（registry 上该版本 `scripts` 为 `null`），改成 `install-electron` bin。项目的 `postinstall` 显式调用它 —— 若用 `--ignore-scripts` 安装，`pnpm run dev` 会起不来，补救是跑一次 `pnpm run postinstall`。 |
| 别给原生模块加 ABI workaround | `better-sqlite3@13` 是 **Node-API** 模块：Node（ABI 127）与 Electron（ABI 149）加载同一份 `prebuilds/*.node`（实测），而且 `lib/binding.js` 优先加载 prebuild、只在找不到时才回退 `build/Release/`。`test:native` 这类脚本因此已删除 —— 不要再引入「换 ABI 才能测」的假设。 |
| `electron-builder.yml` 的 `npmRebuild` 必须是 `false` | 默认 `true` 会**无条件**对原生模块跑 `@electron/rebuild` → `node-gyp` → `make`，即使它已探测到 prebuild（日志里写着 `buildFromSource=false`）也照跑 ⇒ 打包机被迫需要 gcc / make / python3，而且失败信息指不到根因（实测只报 "node-gyp failed to rebuild"）。只在引入**非** N-API 原生依赖时才改回 `true`。 |
| `publish.releaseType` 默认是 `draft` | electron-builder 建出的 Release 停在草稿区：Releases 页面看不到，`electron-updater` 也认不出「最新版本」（草稿不算）⇒ 自动更新**静默失效**，而工作流全绿。另一半更隐蔽：「同名标签的 Release 已发布、而本次发布类型是 `draft`」时它**既不复用也不报错**，只打一条 warn 就跳过上传。因此 `releaseType: release` + 工作流结束前断言终态（非草稿 + 四个产物齐全），见 `docs/packaging.md` 第 7 节与 ADR-0013。 |
| `releaseInfo.releaseNotesFile` **不能设** | 显式点名的资源缺失时 `getResource()` 判为配置错误并**抛错**（`out/platformPackager.js`：`custom` 给了就走抛错分支，只有 fallback 名列表才返回 `null`），而读它的 `createUpdateInfoTasks` 在**每次构建**都会跑到（生成 `latest*.yml`，与 `--publish never` 无关）⇒ 本地 `pnpm run pack` 与 CI 的打包作业一起红，报 `cannot find specified resource "release-notes.md"`。刻意设了它又不提交那个生成物，是必然踩中。发布说明改由 release 工作流 `gh release edit --notes-file` 写入，见 `docs/packaging.md` 第 7 节与 ADR-0014。 |
| AppImage 必须在 Linux 上构建 | 不能从 macOS / Windows 交叉编译。 |
| `syncDesktopName` / `StartupWMClass` / `app.setDesktopName()` 必须同源 | GNOME 按窗口 `app_id` 去找**同名** `.desktop`。`linux.syncDesktopName` 默认 `false` ⇒ 产物文件名退化成 `waachat.desktop`，与 `app_id` 对不上 ⇒ Dock 占位图标、启动器不合并；**而此时 `StartupWMClass` 仍是对的**，所以只断言 WMClass 抓不到。`pnpm run verify` 现在同时断言文件名与 WMClass。理由见 `docs/packaging.md` 第 2 节。 |
| 换了应用图标却只变了一部分 | Linux 下"应用图标"有三个落点，生效时机不同：窗口（`setIcon`，**Wayland 下无效**）、托盘（立即）、启动器 / Dock（`.desktop` 的 `Icon=`，要等桌面刷新或重新登录）。"图标没换"多半不是 bug 而是没重新登录桌面 —— 但改这一处时**三层都要照顾到**，只改一层会得到"托盘换了、窗口没换"这种半截状态。分工与理由见 `docs/decisions.md` ADR-0022。 |
| Ubuntu 24.04+ 限制非特权 user namespace | Electron 沙箱会**静默**失败（双击没反应）。deb 不用管（electron-builder 内建 profile + postinst 自动安装）；AppImage 用户手动装 `/etc/apparmor.d/waachat`。**不要**全局加 `--no-sandbox`。 |
| 从源码跑 `dev` **一定**撞上同一个沙箱问题 | `node_modules/.pnpm/electron@…/dist/electron` 不在任何 profile 的覆盖范围内 ⇒ 内核回落到 SUID 沙箱 ⇒ 启动直接 FATAL（`The SUID sandbox helper binary was found, but is not configured correctly`）。正确做法是 `NO_SANDBOX=1 pnpm run dev`（`electron-vite` 自带的开关，只影响这一条命令）。⚠️ **不要**照报错提示去 `chmod 4755 chrome-sandbox`：本机 `/home` 是 `nosuid` 挂载，setuid 位不生效，做完症状一字不变。细节见 `docs/decisions.md` ADR-0073 的已知限制。 |
| 改动 postinst 引用的 profile 路径会**静默**失效 | postinst 按 `resources/apparmor-profile` 找文件，找不到只打印一行 `Skipping` 后继续 —— 安装「成功」，profile 从未生效。`pnpm run verify` 会把 postinst 里的路径读出来回头验证文件确实在包里。 |
| 本机 `/tmp` 很小时（容器里常见 10M tmpfs），先设 `TMPDIR` | `pnpm run test` 与 `scripts/verify-package.sh` 都要写临时文件：前者报 "database or disk is full" 这类误导性错误，后者解包 deb 时中途失败、**只以 exit 2 退出**（看起来像"两项断言失败"，其实没跑完）。用 `TMPDIR=$PWD/.tmp pnpm run …` 绕开；判断磁盘够不够一律 `df -h .`（项目所在分区），不要 `df -h /`。 |
| **native 模块的失败方式不止"抛错"：还会直接崩** | `better-sqlite3` 的预编译产物与运行环境不匹配（libc / CPU 指令集 / 缺动态库）时进程可能被 SIGSEGV 带走。信号抓不住 ⇒ vitest 只报一句 `Worker forks emitted error`，而那一轮的 9 个 SQLite 用例**静默**少跑（`42 passed` → `33 passed`），与"少写用例"无法区分。所以 `test/helpers/sqlite.ts` 的探测在**子进程**里跑（加载 → 建库 → 应用真实 schema，用 `writeSync` 打阶段标记），崩溃变成可读的跳过原因。**不要**把它改回本进程 `require` + try/catch。 |
| 改了 productName / artifactName 会让 AppImage 的 AppArmor 路径改变 | 挂载点是 `${TMPDIR:-/tmp}/.mount_<AppImage 文件名前 6 字符>XXXXXX`。profile 里因此用 `/tmp/.mount_*/waachat` 通配；设了 `TMPDIR` 的用户需要自己再加一条。 |
| 重画图标后必须**看一眼** `build/icon.png` | ImageMagick 在没有 librsvg 时会把渐变渲染成纯色方块，而且退出码是 0。`scripts/make-icons.sh` 会校验颜色数，但肉眼确认一次仍然值得。 |
| 不要在 `electron-builder.yml` 里手写 `deb.depends` | Ubuntu 的 time_t 过渡把若干库改名成 `*t64`，硬编码列表会失效。理由见 `docs/packaging.md`。 |
| **多实例隔离的唯一杠杆是启动时按实例 `app.setPath('userData'/'sessionData')`** | 它一次挪走登录态、分区存储、`settings.json` 与自定义图标；归档/缓存根再各自按同一个后缀派生（判据全在 `withInstanceSuffix()`）。**不要在子系统里再判一次实例**，也不要在 `whenReady` 之后才改路径。启动顺序（解析实例 → setPath → 申请锁）有一条断言看着：顺序错了不会报错，只会让两个实例抢同一份登录态。详见 [ADR-0062](docs/decisions.md#adr-0062)。 |
| **不要再试图在 WaaChat 里改内嵌页面的语言** | 界面语言的真源是**账号**（随账号同步下来的手机语言，`WALangPhonePref`），入口只在**手机端**。三种杠杆都试过并全部证伪：[ADR-0060](docs/decisions.md#adr-0060) 的会话级 `Accept-Language`（**改不动** `navigator.language`，只影响网络层）、[ADR-0063](docs/decisions.md#adr-0063) 的启动期 `--lang`、[ADR-0065](docs/decisions.md#adr-0065) 的"写下网页版自己那条偏好 cookie `wa_web_lang_pref`" —— 最后一条实测会在 2–3 秒内被页面按账号语言**改回去**（页面自身还有 `WALangPrefDidMismatchWithCookie` 纠错逻辑，我们是在跟它抢）。[ADR-0066](docs/decisions.md#adr-0066) 因此把这一项整个撤掉，设置页只留一句说明。⚠️ 由此**INV-1 的写入例外也一并退休**：`src/` 里不得再出现 `cookies.set(` / `cookies.remove(`（自检第 19 节有负向断言，防它悄悄回来）。⚠️ 一个**仍然生效**的副产品：`role` 菜单项的默认文案取自 Chromium 自己的 locale，而系统 locale 可能是英文 ⇒ 每个 `role` 都要显式给中文 `label`（自检第 19 节断言），否则用户会在**我们自己的**右键菜单里看到 Cut / Copy。 |
| 上游页面结构随时会变 | 接管逻辑只允许依赖**标准内核行为**（下载事件、https 请求），不得依赖任何上游内部函数名或选择器。 |
| **词典下载源是 Edge 的，不是内核默认的 Google CDN** | 默认源（`redirector.gvt1.com/edgedl/chrome/dict/`）在不少网络里会 302 到 `*.gvt1-cn.com` 之后**挂死** —— 内核连 `spellcheck-dictionary-download-failure` 都不发，症状是"设置页一切正常、输入框里一条红线都没有"。`src/main/spellcheck.ts` 的 `DICTIONARY_DOWNLOAD_URL` 因此指向 `edge.microsoft.com/redirectordictionaries/dict/`；删掉那一行＝悄悄回到挂死那条路，自检第 19 节会拦住。⚠️ 查这件事**不能靠看请求日志**：词典请求由**浏览器进程**发出，**既不经过** `protocol.handle`，**也不经过** `webRequest` —— 想拿到它要的确切文件名（全小写，且韩语是 `ko-3-0.bdic`、没有区域码），得把下载源指向一个本机 HTTP 服务器，做法见 [ADR-0068](docs/decisions.md#adr-0068)。 |

## 6. 何时应该停下来问人

以下情况不要自作主张，先提问：

- 需要放宽第 1 节的任一条硬约束
- 需要引入原生依赖或新的系统级权限
- 需要在 `DISCLAIMER.md` 覆盖的范围内做新的行为（例如落盘新的敏感数据）
- 发现文档与代码不一致，且不确定哪边是对的
