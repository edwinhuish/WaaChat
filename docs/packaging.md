# 打包与分发

改 `electron-builder.yml`、`build/`、`.github/workflows/` 之前先读这里。

---

## 1. 产物与命令

| 目标 | 命令 | 产物 | 说明 |
|---|---|---|---|
| 目录（调试用） | `pnpm run pack:dir` | `dist/linux-unpacked/` | 不出安装包，方便快速验证 |
| deb | `pnpm run pack:deb` | `dist/waachat_<版本>_amd64.deb` | Debian / Ubuntu |
| AppImage | `pnpm run pack:appimage` | `dist/WaaChat-<版本>.AppImage` | 免安装，任意发行版 |
| 两者 | `pnpm run pack` | 上述两者 | |
| 构建 + 校验 | `pnpm run verify` | 上述两者 + 断言结果 | **改打包相关代码后必须跑这个** |

每个 `pack*` 都带 `--publish never`（electron-builder 的默认值在 tag 上会尝试发布）。唯一带 `--publish always` 的是 `pack:publish`，只在 release workflow 里用。

`dist/` 与 `out/` 都在 `.gitignore` 里，任何产物都不得提交。

## 2. 关键点一：桌面条目的**名字**必须与 `app_id` 一致

这是本项目最容易踩、且**症状极具误导性**的一个坑。

GNOME / Wayland 靠 `app_id` 把"窗口"和"启动器条目"关联起来。而 `app_id` 既是产物
`.desktop` **文件名的词干**，又是条目里 `StartupWMClass` 的值。因此下面**四处**必须同源：

| 位置 | 值 | 文件 |
|---|---|---|
| `package.json` → `desktopName` | `io.github.edwinhuish.waachat` | `package.json` |
| 产物 `.desktop` **文件名** | `io.github.edwinhuish.waachat.desktop` | `electron-builder.yml` → `linux.syncDesktopName: true` |
| 条目内的 `StartupWMClass` | `io.github.edwinhuish.waachat` | `electron-builder.yml` → `linux.desktop.entry` |
| 运行期声明 | `app.setDesktopName('io.github.edwinhuish.waachat.desktop')` | `src/main/index.ts` |

不一致的后果：Dock 上显示**通用占位图标**、已固定的图标与运行窗口**不合并**（出现两个图标）、启动器图标上不显示运行点。看起来像"图标没打进去"，实际是身份不匹配。

> **多实例共用这一个身份**（[ADR-0062](decisions.md#adr-0062)）：`--profile <名>` 只影响**数据落在哪**，不参与 `app_id`、产物文件名与 `StartupWMClass` —— 上面这张表因此不需要参数化，`verify-package.sh` 的断言也不用改。代价是启动器 / Dock 里只有一个图标（同一个应用开两份数据，这本来也是用户对"多开"的预期），区分实例靠窗口标题与托盘菜单第一行。若将来真要"每个实例一个桌面身份"，那要连带改这张表的四处，属于一次独立评估。

### 2.1 为什么必须显式打开 `syncDesktopName`

`linux.syncDesktopName` **默认是 `false`**。此时 electron-builder 把产物 `.desktop`
的文件名取成 `executableName`（→ `waachat.desktop`），**而不是** `desktopName`。
于是"文件名"与"窗口报出的 `app_id`"变成了两个不同的值 —— GNOME 按 `app_id`
去找同名文件，找不到就回落到占位图标。

失败之所以**静默**：此时 `StartupWMClass` 是正确的。只断言 `StartupWMClass` 的校验
发现不了它 —— 这正是本仓库最想拦住的那类问题。

依据（electron-builder 26.15.3，`app-builder-lib` 的 `LinuxTargetHelper`）：

```js
getDesktopFileName(fallback = this.packager.executableName) {
  if (!this.packager.platformSpecificBuildOptions.syncDesktopName) return fallback
  return this.packager.info.metadata.desktopName.replace(/\.desktop$/, '')
}
```

官方 schema 原文：*"When `true`, the installed `.desktop` filename is derived from
`desktopName` in `package.json` (minus the `.desktop` suffix) so that it matches
`StartupWMClass` and Electron's `app_id`. Falls back to `executableName` when
`desktopName` is absent."* 该开关在 electron-builder v27 里默认会变成 `true`
（[#9103](https://github.com/electron-userland/electron-builder/issues/9103)）；
这里显式钉住，避免将来升级时行为静默改变。

`scripts/verify-package.sh` 会解包产物并**同时**断言"文件名"与 `StartupWMClass` 两项，
`pnpm run verify` 与 CI 都会跑。

### 2.2 运行期还会再写一份**用户级**覆盖

用户换了应用图标时（ADR-0022），应用会在 `~/.local/share/applications/<appId>.desktop`
写一份**用户级**条目，`Icon=` 指向 `~/.config/waachat/custom-icon.png`，其余键由
`shared/appicon.ts` 的 `buildDesktopEntry()` 拼出。

这不是与上面那份打架，而是 XDG 的查找顺序在起作用：同名条目在用户目录里优先，因此
**不需要 root**，卸载时系统那份也仍然完好。「恢复默认」会把用户级那份删掉。

据此有两条约束：

- **`buildDesktopEntry()` 必须继续带 `Comment=…unofficial…` 与 `StartupWMClass=<appId>`。**
  它取代了安装产物里那份条目，因此 INV-4 的义务跟着一起走。`pnpm run selfcheck` 两条都断言
  （并且会回头核对 `Comment` 与 `electron-builder.yml` 里的那一行同文）。
- **`Exec` 在 AppImage 下必须取 `process.env.APPIMAGE`**，而不是挂载点里的可执行文件 ——
  挂载点每次启动都不同（与 `integration/login.ts` 是同一个陷阱）。

开发模式下**不写**这份覆盖：那时的 `Exec` 只能指向 `node_modules` 里的 Electron。

### 深链接：`MimeType` 与 `Exec` 的 `%U` 必须同时在

系统里点一个 `whatsapp:` 链接时能不能落到我们的对话上，取决于**两条**声明，而它们**缺一不可**
（[ADR-0083](decisions.md#adr-0083)）：

| 键 | 少了它的症状 |
|---|---|
| `MimeType=x-scheme-handler/whatsapp;` | 系统不认识这个 scheme ⇒ 点链接**什么都不会发生** |
| `Exec=… %U` | 关联是通的，但 URL 不会被当参数传进来 ⇒ 应用被拉起来、**停在首页** |

两处都要写：

- **安装产物那份**在 `electron-builder.yml` 的 `linux.desktop.entry`（`MimeType` 显式给了；
  `%U` 是 electron-builder 自己按 `executableName` 生成的 —— 实测 26.15.3 对 deb 与 AppImage
  都带上它，因此**不要**手写 `Exec` 去覆盖那个计算值）。
- **用户级那份**在 `shared/appicon.ts` 的 `buildDesktopEntry()`（用户换过图标之后它生效，
  同名条目在用户目录里优先）。那份必须**自带**这两个键，否则"换过一次图标"就等于**静默**丢掉
  深链接 —— 而这恰好不会在构建期或运行期报错。

`scripts/verify-package.sh` 因此对**产物**断言 `MimeType` 与 `Exec` 的 `%U`（deb 与 AppImage
各一次），`pnpm run selfcheck` 另外断言 `buildDesktopEntry()` 那一份也带着它们。

## 3. 关键点二：AppImage 不再需要 FUSE2

```
toolsets:
  appimage: "1.0.3"
```

传统 AppImage 运行需要 `libfuse2`：

- FUSE2 自 2017 年起无人维护；
- Ubuntu 24.04+ 已把它改名为 `libfuse2t64`，用户装不上会看到 `dlopen(): error loading libfuse.so.2`。

静态 runtime 工具链把挂载逻辑内联进 AppImage，**彻底去掉这个依赖**，用户拿到即能跑。
electron-builder v27 将把它设为默认值；现在显式固定，是为了避免将来某次升级静默改变产物行为。

## 4. 关键点三：Ubuntu 24.04+ 的 user namespace 限制

Ubuntu 24.04 起默认限制**非特权 user namespace**。这会破坏 Electron 的进程沙箱，症状是：

> 从文件管理器双击应用**没有任何反应**；从终端运行却正常。

三种处理方式，按推荐度排序：

1. **针对性 AppArmor profile**（推荐）。分两种情形：

   - **deb：全自动。** electron-builder 内建生成一份 profile（`resources/apparmor-profile`），安装包的 postinst 会把它装到 `/etc/apparmor.d/waachat` 并加载。用户什么都不用做。
   - **AppImage：需要手动装一次。** 挂载出来的可执行文件路径是随机的（`/tmp/.mount_WaaChaXXXXXX/waachat`，前 6 个字符来自产物文件名），所以随包另附一份覆盖两条路径的完整版（`resources/apparmor/waachat`）：

     ```bash
     ./WaaChat-1.0.0.AppImage --appimage-extract
     sudo cp squashfs-root/resources/apparmor/waachat /etc/apparmor.d/
     sudo apparmor_parser -r /etc/apparmor.d/waachat
     ```

   profile 的形态与 Ubuntu 官方为 VS Code 等应用提供的完全一致（`abi <abi/4.0>` + `flags=(unconfined)` + `userns,`），因此只放行 user namespace，不改变其它权限。

   > ⚠️ 这两份 profile 的机制、以及它们最容易坏掉的地方，见第 6 节「AppArmor：两份 profile，职责不同」。要点：postinst 会**静默跳过**它找不到的文件，所以 `scripts/verify-package.sh` 不满足于"文件在包里"，还会把 postinst 里的路径读出来回头核对。

2. **新版 AppRun 的自动回退**：静态 runtime 的 `AppRun` 会探测 user namespace 是否可用，仅在不可用时追加 `--no-sandbox`。

3. **全局 `--no-sandbox`**：能跑，但等于关掉 Chromium 的进程隔离。**不推荐**，不要写进默认的 `.desktop`。

## 5. 关键点四：不要手写 `deb.depends`

`electron-builder.yml` 里**刻意没有** `depends` 字段（见 [ADR-0004](decisions.md#adr-0004)）。原因：

- electron-builder 内建的依赖列表与所固定的 Electron 版本匹配；
- 手工维护的列表会腐坏：Ubuntu 的 time_t 过渡把若干库改名成 `*t64`（如 `libasound2` → `libasound2t64`），硬编码旧名字会让 `apt install` 直接报依赖不满足；
- 一个**错的**依赖列表比**默认的**更糟，因为它在开发者的机器上通常不会暴露。

确实需要追加时：

- 用 `A | B` 的替代写法覆盖跨版本差异，例如 `libasound2 | libasound2t64`；
- 明确列出完整列表（覆盖默认值）；
- 在 `docs/decisions.md` 追加 ADR 说明为什么默认值不够；
- 跑 `pnpm run verify`，它会把产物里的依赖字段打印出来。

托盘图标依赖放 `recommends`（`libayatana-appindicator3-1`）：缺失时只是没有托盘图标，应用仍可用，因此不该是硬依赖。GNOME 用户还需要 AppIndicator 扩展。

## 6. 构建环境约束

| 约束 | 原因 |
|---|---|
| AppImage **必须在 Linux 上构建** | 不能从 macOS / Windows 交叉编译；CI 用 `ubuntu-24.04` |
| 原生模块**无需**按 ABI 重建 | `better-sqlite3` 13.x 是 Node-API 模块，Node 与 Electron 共用同一份 `prebuilds/*.node`（实测 ABI 127 / 149 均可加载），因此**没有** `install-app-deps` 这一步，见下节 |
| arm64 需要独立 runner | 当前只出 x64；arm64 需要 `ubuntu-24.04-arm` 或 QEMU，见 [roadmap](roadmap.md) |

### 原生模块：Node-API，不存在 per-ABI 重建

早期版本这里写着「`.node` 只能被一个 ABI 加载，所以 vitest 加载不了 `better-sqlite3`，
需要 `test:native` 临时换 ABI」。**那个前提是错的**，实测：

```
node -e "require('better-sqlite3')"                             # NODE_MODULE_VERSION 127 ✓
ELECTRON_RUN_AS_NODE=1 electron -e "require('better-sqlite3')"  # NODE_MODULE_VERSION 149 ✓
```

`better-sqlite3@13` 是 **Node-API（N-API）** 模块，ABI 稳定，`prebuilds/linux-x64.node`
一份二进制两边通用。而且它**优先加载 prebuild** —— `lib/binding.js` 的 `getBinding()`
先调 `getPrebuildPath()`（即 `prebuilds/<platform>-<arch>.node`），只有找不到时才回退到
`build/Debug|Release/better_sqlite3.node`。因此：

- `test/unit/store.test.ts` 里的 SQLite 索引用例在普通 `pnpm run test` 下**真的会执行**；
- 不需要、也不该有任何 ABI 交换的 workaround（`test:native` 这类脚本已删除）；
- **不需要** `electron-builder install-app-deps`。它的职责是按 Electron 的 ABI 重建原生模块，
  而当前唯一的重建对象不存在。

### `npmRebuild: false` 是刻意的，别改回默认值

`electron-builder.yml` 里显式设 `npmRebuild: false`。electron-builder 的默认值是 `true`，
会**无条件**对原生模块跑 `@electron/rebuild` → `node-gyp` → `make` —— 即使它已经探测到
prebuild、日志里明确写着 `buildFromSource=false`，node-gyp 那条链路**仍然会执行**。

代价是打包机被迫具备 gcc / make / python3，而失败信息完全指不到根因。实测踩过一次：
node-gyp 去 unlink 它自己造的 `build/node_gyp_bins/python3` 时报 `EPERM`，最终只留下
一句 `node-gyp failed to rebuild 'better-sqlite3'`。

⚠️ 一旦引入**非** N-API 的原生依赖（带 ABI 号的 prebuild，或依赖 `node-gyp-build`
现场编译），这里必须改回 `true`，否则会打出一个在 Electron 下加载失败的原生模块。

### `postinstall` 现在只做一件事：拉 Electron 二进制

**Electron 44 已经删掉了自身的 `postinstall`**（registry 上该版本 `scripts` 为 `null`），
改成一个名为 `install-electron` 的 bin。于是「自动下载二进制」从装依赖的副作用变成了
项目自己的责任，`package.json` 里显式声明：

```json
"postinstall": "install-electron"
```

`install.js` 自身幂等（比对 `dist/version` 与 `path.txt` 后直接退出），重复执行无代价。
用 `pnpm install --ignore-scripts` 装完之后 `pnpm run dev` 会报
"Electron failed to install correctly" —— 补救就是 `pnpm run postinstall`。

> 这也是本项目唯一一个 `postinstall` 的用途。没有第二个「装完自动做点什么」的钩子 ——
> 那种钩子是排查「为什么我的机器上行为不一样」时最难想到的一环。

### AppArmor：两份 profile，职责不同

electron-builder **内建**生成一份 AppArmor profile，落点 `resources/apparmor-profile`，
并在生成的 postinst 里装到 `/etc/apparmor.d/waachat`。它只覆盖 deb 的
`/opt/WaaChat/waachat`。

想用自己写的 profile 替换它是**无效的**：把文件放到 `build/apparmor-profile` 会被忽略，
electron-builder 仍然写自己的模板（实测：提交 1480 字节的文件，产物里是 217 字节的模板）。

所以「覆盖 AppImage 挂载路径 `/tmp/.mount_*/waachat`」只能另附一份
`build/apparmor/waachat`，经 `extraResources` 到 `resources/apparmor/`，供 AppImage 用户
手动安装。三处名字必须同源（文件名 = profile 声明的名字 = postinst 的目标路径 =
`executableName`），否则同一份 profile 会以两个身份出现，`apparmor_parser` 加载时冲突。

⚠️ **真正致命的失败模式是路径对不上。** postinst 在装 profile 前会先跑
`apparmor_parser --skip-kernel-load --debug` 预检；预检失败时它只打印一行
`Skipping the installation...` 就继续了 —— 安装「成功」，profile 从未生效，症状要到
用户双击图标没反应时才暴露。`scripts/verify-package.sh` 会把 postinst 里的
`APPARMOR_PROFILE_SOURCE` 读出来、回头验证该文件确实在包里，专门盯这一条。

## 7. CI 与发布

### PR（`.github/workflows/ci.yml`）

两个并行任务：`check`（lint + 格式 + 类型 + 单测 + 自检）与 `package`（构建 + 校验 + 上传产物供排查）。
两者都调用 `package.json` 里同名的 scripts，**保证与本地完全一致** —— CI 里不存在第二条命令路径。
唯一的差别是安装那一步带 `--frozen-lockfile`（该处必须失败，而不是悄悄改写锁文件）。

### 发布（`.github/workflows/release.yml`）

工作流由**推送 `v*` 标签**触发，唯一入口是：

```bash
pnpm run release                          # 交互式选版本（patch / minor / major / 自定义）
pnpm run release --release minor          # 直接指定版本类型，或直接给版本号（如 1.0.0）
pnpm run release --release 1.0.0 --yes    # 非交互：连最后的确认也跳过（脚本里用）
```

⚠️ **不要**写成 `pnpm run release -- --release minor`。本仓库钉死的 pnpm 12.10.1 会把 `--`
**原样转发**给脚本（实测 `pnpm run release -- --help` 的回显是 `$ bumpp -- --help`），而
`bumpp` 只解析「脚本名之后的裸参数」：带 `--` 时那些 flag 会落到它的位置参数（文件名）上 ——
版本参数不生效、弹出交互式选择器，最后还会去 bump 一个叫 `--release` 的文件。

它执行 `bumpp`（配置在 `bump.config.ts`）：提升 `package.json` 的版本 → 提交
`chore(release): v<版本>` → 打**附注**标签 `v<版本>` → 推送提交与标签。选型理由见
[ADR-0012](decisions.md#adr-0012)。

**推标签是不可回退的动作** —— 事后删掉 Release 也收不回已经散出去的 `latest-linux.yml`。
所以配置里显式打开了 `noGitCheck`（要求工作区干净）：发布提交里只应有版本号这一处改动。
`CHANGELOG.md` 因此必须**在此之前单独提交**，完整步骤见 [`../ai/TASKS.md`](../ai/TASKS.md) 的 T6。

几个需要知道的行为：

- 标签是**附注标签**，标签消息与发布提交信息相同。
- 推送用的是 `git push` + `git push --tags`：**本地其它尚未推送的标签也会一并推上去**。发布前用 `git tag -l` 确认一下没有多余的标签。
- 版本号由 `bumpp` 从 `package.json` 读出并写回，人手不接触它；落盘前它会再确认一次（`confirm` 默认开启）。
- `bumpp` 打的是**当前提交**，它不校验分支 —— 从 `main` 发布是流程要求，不是工具保证。
- 需要签名的标签：`pnpm run release --sign`（参数直接跟在脚本名后，见上面的警告）。

流程：**校验标签与版本** → 静态检查 → 构建并校验 → 生成 Changelog → **创建 Release +
上传产物** → 写入发布说明 → 附 `SHA256SUMS.txt` → 断言终态（已发布 + 说明非空 + 四个文件齐全）
→ 归档产物 30 天。

⚠️ 校验标签排在**最前面**（安装依赖之前）：`workflow_dispatch` 的标签输入一旦填错，得到的会是
明确的"标签与 `package.json` 的版本不一致"，而不是十几分钟后一段与标签毫无关系的报错。

**为什么用 electron-builder 自己的 publisher**：它同时生成自动更新所需的 `latest-linux.yml`。自己拼发布流程最容易漏掉的就是这个文件，而漏掉之后自动更新会**静默失效**——不报错，只是永远不更新。

#### Release 是怎么被创建并发布的

三处合起来才构成"推标签之后 Release 页面自动出现新版本"，**缺任何一处都不会报错**（工作流照旧全绿）：

| 位置 | 作用 | 缺了会怎样 |
|---|---|---|
| `electron-builder.yml` → `publish.releaseType: release` | 让 electron-builder 建出的 Release 直接是**已发布**状态 | 默认值是 `draft`：Release 停在草稿区，页面上看不到，`electron-updater` 也认不出"最新版本"（草稿不算） |
| `release.yml` → 「写入发布说明并确保已发布」 | `gh release edit --notes-file` 把生成的说明写进 `body`，并把遗留草稿转正 | 发布说明为空；同名标签若早已是草稿，会永远是草稿（electron-builder 复用草稿但不转正） |
| `release.yml` → 「验证 Release 状态、发布说明与产物」 | 断言已发布、说明非空且提到本次标签、四个文件都在 | electron-builder 在"类型不兼容"或"距发布超过 2 小时"时只打一条 warn 就**跳过上传**，退出码仍是 0 |

⚠️ **不要在 `electron-builder.yml` 里设 `releaseInfo.releaseNotesFile`。** 直觉上它正是"把发布说明交给 Release"的开关，但显式点名的资源在文件不存在时被 `getResource()` 判为**配置错误并抛错**，而读取它的 `createUpdateInfoTasks` 在**每次构建**都会跑到（要生成 `latest*.yml`，与 `--publish never` 无关）—— 于是本地 `pnpm run pack` 与 CI 的打包作业会一起红，报错是 `cannot find specified resource "release-notes.md"`。不设它时该文件名仍在 electron-builder 的隐式候选列表里（存在就读、不存在就安静跳过），但发布说明已由工作流显式写入，不依赖这条隐式路径。理由见 [ADR-0014](decisions.md#adr-0014)。

发布说明由 [`.github/scripts/generate-changelog.sh`](../.github/scripts/generate-changelog.sh) 从**约定式提交**（[`../ai/CONVENTIONS.md`](../ai/CONVENTIONS.md) 第 9 节）生成：按 `feat` / `fix` / `perf` / `refactor` / `docs` 分节，附对比链接与非官方声明；产出文件 `release-notes.md` 由工作流用 `gh release edit --notes-file` 写入 Release，**不经过 electron-builder 的配置**。它是生成物，已在 `.gitignore` 里 —— 提交上去会让 `bumpp` 的"工作区必须干净"检查误判。

⚠️ **它不替代 `CHANGELOG.md`。** 前者是"这个标签区间里有哪些提交"（Release body，自动生成），后者是"为什么这样改"（人工撰写的中文文档，见 [ADR-0012](decisions.md#adr-0012)）。

标签与 `package.json` 的版本必须一致：electron-builder 只按 `v<package.json 的 version>` 决定发布到哪个标签，与触发工作流的引用无关，不一致时它会往另一个标签上发且不报错。工作流因此把这种不一致当成**构建前的失败**（`pnpm run release` 已保证这一点，手工 `git tag` 才需要留意）。

`workflow_dispatch` 只用于对**已存在**的标签重跑或补发：输入留空则用触发引用的标签，标签不存在、或与 `package.json` 的版本不一致，都会在构建之前失败。重跑时 `EP_GH_IGNORE_TIME=true` 显式关掉 electron-builder 那个"已发布超过 2 小时就不再上传"的时间窗，否则它只打一条 warn 就跳过。

发布前仍需人工确认的事：

- [ ] `CHANGELOG.md` 已更新并**提交**（版本号与 `pnpm run release` 时选的一致）
- [ ] `git tag -l` 里没有多余的本地标签（推送会带上全部本地标签）
- [ ] 在**干净的虚拟机或容器**里实测安装（`dpkg -i` 与直接运行 AppImage），确认不是"我机器上能跑"
- [ ] `DISCLAIMER.md` 的表述仍然准确
- [ ] Release 页面上的状态是**已发布**（不是草稿），标题/标签是本次版本，说明里有本次变更

## 8. 本地安装用于测试

```bash
# deb
sudo apt install ./dist/waachat_1.0.0_amd64.deb
# 卸载
sudo apt remove waachat

# AppImage
chmod +x dist/WaaChat-1.0.0.AppImage
./dist/WaaChat-1.0.0.AppImage
```

用 `apt install ./file.deb` 而不是 `dpkg -i`：前者会自动处理依赖，后者不会。

## 9. 后续可加的渠道

| 渠道 | 价值 | 备注 |
|---|---|---|
| AUR（`PKGBUILD`） | Arch 用户是这类工具的核心受众 | 成本低，值得优先 |
| Flatpak | 沙箱化分发，利于建立信任 | 需要处理沙箱内的 `xdg-open` 与门户交互 |
| arm64 | 覆盖 ARM 笔记本 | 见 `roadmap.md` |

新增渠道需要先追加 ADR：它会带来新的"用户看到的外观与实际行为不一致"的风险面（尤其是沙箱渠道下的文件打开与托盘）。
