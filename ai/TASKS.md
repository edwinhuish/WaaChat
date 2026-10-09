# 常见任务手册

每个任务给出：**何时用 / 步骤 / 检查点 / 容易错的地方**。
命令一律来自 `package.json` 的 `scripts`（下面是 `pnpm run <名字>`），与 CI 完全一致 —— 没有 Taskfile，也没有第二套命令体系。

---

## T1 · 诊断「接管失效」

**何时用**：用户报告"点文件没反应 / 还是下载到 `~/Downloads`"。

**步骤**

1. 确认不是环境问题（Ubuntu 24.04+ 沙箱、托盘扩展）。见 [`../docs/usage.md`](../docs/usage.md) 第 1 节。
2. 从终端启动，抓接管相关日志：
   ```bash
   waachat 2>&1 | grep -iE 'download|capture|cache|archive' | tail -40
   ```
3. 按日志判断停在哪一步：

   | 现象 | 说明 | 下一步 |
   |---|---|---|
   | 完全没有下载事件 | 上游不再经由下载管理器 | 接管点 A 失效，需重新寻找内核层落点 |
   | 有事件但没归档 | 归档写入失败（权限/磁盘） | 检查**当前归档目录**（默认 `~/Documents/WhatsApp_files`，可在设置里改）的权限与可用空间 |
   | 归档了但没打开 | MIME 关联问题 | 与本项目无关，`xdg-mime query default <类型>` |
   | 二次点击仍联网 | 接管点 B 失效 | 检查幂等键推导是否仍能命中 |

4. 跑离线自检：`npx tsx scripts/check-capture.ts`
5. 提 issue 时使用**接管失效**模板（会自动问到关键信息）。

**检查点**：能明确定位到"哪个接管点、哪一步"失效。**不要**在没有定位前就改代码。

---

## T2 · 新增一个 IPC 通道

**何时用**：渲染进程需要从主进程取数据，或触发一个明确的操作。

**步骤**

1. 在 `src/main/ipc/channels.ts` 加通道名常量。
2. 在 `src/main/ipc/index.ts` 注册处理器，**校验 `event.senderFrame`**。
3. 在 `src/preload/index.ts` 暴露一个方法。方法签名只接受**主进程产生的标识**，不接受任意路径。
4. 在 `src/renderer/` 消费。
5. 类型放 `src/shared/types.ts`（主渲染两侧共享）。

**检查点**

- [ ] 通道名没有以字面量形式出现在两处以上
- [ ] 处理器校验了来源
- [ ] preload 暴露的方法**不构成"让远程页面发起本地动作"的通道**
- [ ] 参数里没有原始路径字符串

**容易错的地方**：为了图省事做成 `fs:readAny(path)` 这类通用通道（违反
[G-1 / G-2](INVARIANTS.md)）；忘记校验来源，导致远程页面可调用。

---

## T3 · 改桌面集成或打包配置

**何时用**：改应用名、图标、`.desktop` 条目、依赖字段、目标格式。

**步骤**

1. **四处身份声明必须同时改**：`package.json` 的 `desktopName`、
   `electron-builder.yml` 的 `linux.syncDesktopName`（它决定产物 `.desktop` 的
   **文件名**）、`linux.desktop.entry.StartupWMClass`、
   `src/main/index.ts` 的 `app.setDesktopName()`。
   漏掉 `syncDesktopName` 时文件名会退化成 `<executableName>.desktop`，而
   `StartupWMClass` 仍是对的 —— 只改别处会让 Dock 静默显示占位图标。
2. 若改了图标：改 `build/icon.svg` 后跑 `pnpm run icons`。
3. 若改依赖字段：先读 [`../docs/packaging.md`](../docs/packaging.md) 第 5 节（**不要手写 `deb.depends`**）。
4. 跑：
   ```bash
   pnpm run verify
   ```
5. 在**干净容器**里实测：
   ```bash
   docker run --rm -it -v "$PWD/dist:/d" ubuntu:24.04 bash
   # 容器内：apt install /d/*.deb，然后启动应用，检查图标是否为占位图
   ```

**检查点**

- [ ] `pnpm run verify` 通过（它会断言 `.desktop` **文件名**与 `StartupWMClass` 两项，以及图标）
- [ ] 若应用名或 `Comment` 改过：运行期生成的**用户级**启动器条目仍然带 `Comment=…unofficial…`
      与 `StartupWMClass=<appId>`（`pnpm run selfcheck` 会核对它与 `electron-builder.yml` 同文）
- [ ] 干净环境里图标**不是**通用占位图标
- [ ] 已固定的启动器图标与运行窗口**合并为一个**（不是两个）
- [ ] AppImage 在**未安装 libfuse2** 的系统上能跑

**容易错的地方**：只改了 `electron-builder.yml` 的 `StartupWMClass` 就以为完事
（漏掉 `linux.syncDesktopName`、漏掉 `app.setDesktopName()`）；
漏掉运行期生成的那份用户级启动器条目（ADR-0022）；
只看本地机器（本地往往已经缓存了旧图标）。

---

## T4 · 升级 Electron（或其它核心依赖）

**步骤**

1. 先看 `dependabot.yml` 是否已忽略该升级 —— 若已忽略，说明它需要人工处理，不是随手 merge。
2. 升级并拉取对应的 Electron 二进制：
   ```bash
   pnpm install electron@<版本>
   pnpm run postinstall      # = install-electron，幂等；不跑的话 dev 会报安装不完整
   ```
3. `pnpm run check` → `pnpm run verify`
4. 在干净环境实测安装与启动。
5. 若这次升级改变了用户可见行为（产物格式、沙箱策略、依赖需求），更新
   [`../docs/packaging.md`](../docs/packaging.md) 并在 `CHANGELOG.md` 记一条。

**检查点**

- [ ] `pnpm run verify` 通过
- [ ] `node_modules/electron/dist/version` 与 `package.json` 里的版本一致（不一致说明二进制没拉下来）
- [ ] 知道**不需要**给 `better-sqlite3` 做 ABI 重建 —— 它是 Node-API 模块（见 [`../docs/packaging.md`](../docs/packaging.md) 第 6 节）
- [ ] `electron-builder.yml` 的 `npmRebuild` **仍是 `false`** —— 换 Electron 大版本不改变这个结论（N-API 的 ABI 稳定性与 Electron 版本无关）；改回 `true` 只会让打包机凭空需要 gcc / make / python3
- [ ] `typescript` **仍锁在 6.0.x**（`typescript-eslint` 的 peer 约束，见 [G-6](INVARIANTS.md)）

---

## T5 · 改接管逻辑（`src/main/capture/`）

**何时用**：任何涉及下载事件、协议层拦截、幂等键的改动。**风险最高的改动。**

**前置**：先读 [`../docs/media-capture.md`](../docs/media-capture.md) 全文，特别是第 3、5 节。

**步骤**

1. 确认改动**只依赖标准内核行为**，不依赖上游任何内部结构。
   > 若改的是 **host 判据**：先读 [ADR-0015](../docs/decisions.md#adr-0015)。收窄只会漏命中（可容忍），
   > 放宽则会把网页自身的资源写进密文缓存，并绕过 Chromium 的 HTTP 缓存重校验。
   > 若改的是**回放哪些响应头**（`capture/headers.ts`）：先读 [ADR-0016](../docs/decisions.md#adr-0016)。
   > 漏掉一个"决定浏览器怎么处置这份响应"的头（COEP / COOP / CSP …）会让页面局部坏掉而且**只在缓存命中时**出现；
   > 白名单一变就**必须**提升 `capture/cache-files.ts` 的 `CACHE_VERSION`，否则老用户机器上的旧条目会继续被回放。
2. 若动了幂等键：必须在**三种媒体类型**（图片 / 视频 / 文档）上分别验证稳定性。
   > 宁可漏命中，不可错命中 —— 错命中会让用户打开到解不开的文件。
3. 若动了落盘流程：保持"随机临时名 → 哈希 → 原子 `rename`"的顺序，并保留启动时清扫 `.part-*`。
   > 密文缓存有**两套**收拾逻辑，别混：`reconcileCiphertextCache()` 是启动对账（兜底：崩溃恢复 +
   > 把设置贯彻到底），`convertCache()` / `purgeStaging()` 是用户拨动开关时发起的一次切换
   > （静默、事务式、可回退）。`cache-switch.ts` 负责把"切协议层 → 转换 → 落设置 → 收尾"串成一次
   > 要么全成、要么全不成（ADR-0027）。改条目形态或后缀时这几处都要跟着改；它们**不动**不认识的
   > 扩展名与非普通文件 —— "不删别人的东西"这条纪律别顺手放宽。
   > 另外：`cache/.staging/` 是转换期间的可回滚存放处，**不能**让它被 `isEntryName()` 认成条目
   > （认错的话对账会连内容一起清掉，"回滚"当场失效；`scripts/check-capture.ts` 有断言守着）。
   > PDF 那一层（`capture/pdf.ts`，[ADR-0029](../docs/decisions.md#adr-0029) /
   > [ADR-0030](../docs/decisions.md#adr-0030)）由设置 `disablePdfPreview` 控制、**默认关闭**，而且
   > **每个请求现读**（`attachPdfHandling()` 收的是读取函数，`window.ts` 的窗口处理也是每次现读 ——
   > 别把它读成快照，否则"改了设置不生效"）。两个挂点的分工是实测逼出来的：挡上游预览页只能用
   > `webRequest.onBeforeRequest`（即使请求会被 `protocol.handle('https')` 接住，它的取消仍然生效），
   > 而把 PDF 降级成下载只能放在 `protocol.ts` 的 `passthrough()` 里（协议处理器返回的响应，
   > `webRequest` 改不动）。改判据（`shared/upstream.ts` 的 `isDocumentPreviewPage()` /
   > `pdf.ts` 的 `isPdfResponse()`）时，自检那一节会先变红；把开关默认值改成 true、或放宽预览页
   > 判据，后果分别是"没做过选择的用户点 PDF 没反应"与"应用内又出现 PDF 预览"，都没人会立刻发现。
4. 补单测（纯逻辑部分必须能在无 Electron 环境下测试）。
5. 手动验证：
   - 首次点击一个文件 → 直接打开，`~/Downloads` 无残留
   - 同一文件转发到另一会话再点击 → 归档文件数不增加
   - 断网后点击已缓存过的文件 → 仍能打开（若改动涉及接管点 B）

**检查点**

- [ ] 失效时**有提示**，不是静默退回原生下载
- [ ] 归档目录里没有 `.part-*` 残留
- [ ] 索引中的记录在磁盘上全部存在（无悬空记录）
- [ ] 没有引入任何解密 / 密钥相关代码（[INV-3](INVARIANTS.md)）

---

## T6 · 发布一个版本

**步骤**

1. 在 `main` 上决定新版本号，并把 `CHANGELOG.md` 的 `[Unreleased]` 归入
   `## [x.y.z] - <日期>`：同时新增底部的 `[x.y.z]:` 链接、把 `[Unreleased]` 的
   compare 起点改成这个版本。提交它。
   > 这一步必须在发布命令**之前**完成并提交：发布命令要求工作区干净，而它自己只改
   > `package.json` 的版本号（见 `bump.config.ts` 的 `noGitCheck`）。
2. 跑发布命令，版本号与上一步选的一致：
   ```bash
   pnpm run release                          # 交互式选版本（patch / minor / major / 自定义）
   pnpm run release --release minor          # 直接指定版本类型，或直接给版本号（如 1.0.0）
   pnpm run release --release 1.0.0 --yes    # 非交互：连最后的确认也跳过
   ```
   > ⚠️ 参数**直接跟在脚本名后面**，不要写 `pnpm run release -- --release minor`：
   > pnpm 12.10.1 会把 `--` 原样转发（回显是 `$ bumpp -- --release minor`），那些 flag 于是
   > 变成 bumpp 的位置参数（文件名）—— 版本参数不生效、弹出交互式选择器，最后还会去 bump
   > 一个叫 `--release` 的文件。实测踩过。
   它执行 `bumpp`（配置在 `bump.config.ts`）：提升 `package.json` 的版本 → 提交
   `chore(release): v<版本>` → 打 `v<版本>` 附注标签 → 推送 → 触发 release workflow。
3. 等待 Release 工作流完成。**Release 由工作流自动创建并发布**，不需要人工点 Publish；
   发布说明（按 `feat` / `fix` / … 分节、附对比链接）也是自动生成的。
   检查 Release 页面：标题是版本号、标签是 `v<版本>`、说明里有本次变更，且
   `.deb`、`.AppImage`、`latest-linux.yml`、`SHA256SUMS.txt` 四个文件都在。
4. 若工作流失败要重跑：Actions → Release → Run workflow，标签填 `v<版本>`（该标签必须已存在，
   且与 `package.json` 的版本一致）。
   > ⚠️ **不要填一个与当前版本不符的历史标签。** `checkout` 会按它把整个运行拉回旧提交，
   > 于是你看到的是"旧代码 + 旧 Node"报出来的错，与当前代码无关（实测踩过）。工作流第一步
   > 就会校验标签与版本是否一致，填错会在几十秒内明确报出来。
   工作流最后一步会把"产物没传上去 / 发布说明为空"变成红灯；它变红时先看
   `pnpm run pack:publish` 那一步的日志里有没有 `GitHub release not created` / `skipped publishing`，
   有的话说明标签对不上或 Release 是草稿 —— 见 [`../docs/packaging.md`](../docs/packaging.md) 第 7 节。
5. 在干净环境实测安装。

**检查点**

- [ ] 四个文件都在 Release 里（**`latest-linux.yml` 缺失会导致自动更新静默失效**）
- [ ] Release 是**已发布**状态（不是草稿）—— 草稿在 Releases 页面上看不到，也会让自动更新静默失效
- [ ] Release 的标签与 `package.json` 的版本一致（`v<版本>`）
- [ ] Release 说明里有本次变更（不是"没有可归类的改动"——那说明提交信息没用约定式前缀）
- [ ] deb 与 AppImage 都能装上并启动
- [ ] `CHANGELOG.md` 的链接指向正确的 tag，且小节版本与标签一致
- [ ] 发布提交里**只有** `package.json`（`git show --stat v<版本>` 确认）
- [ ] 推送前 `git tag -l` 里没有多余的本地标签（`bumpp` 用 `git push --tags`，会把它们一起推上去）

---

## T7 · 新增一条硬约束

**何时用**：发现了一类会导致项目性质改变、必须被机器拦住的写法。

**步骤**

1. 在 `docs/decisions.md` 追加 ADR：说明这是放弃了哪条路线、为什么。
2. 在 `ai/INVARIANTS.md` 增加条目，**必须包含自查方式**（可执行的 `rg` 命令或 lint 规则）。
3. 在 `eslint.config.mjs` 里加守卫规则（如果可以用 lint 表达）。
4. 同步 `AGENTS.md` 第 1 节的表。
5. 若这条约束改变了用户承担的风险，同步 `DISCLAIMER.md`。

**检查点**

- [ ] 四处（ADR / INVARIANTS / eslint / AGENTS）一致
- [ ] 新规则**现在就能通过**（不要在引入守卫的同时留下既存的违规）

---

## T8 · 新增或修改文档

**步骤**

1. 判断它属于哪一类：
   - 面向人、解释"为什么/是什么" → `docs/`
   - 面向 AI、给出"禁止什么/怎么做" → `ai/`
   - 使用者的操作说明 → `docs/usage.md`
2. 在 [`../docs/README.md`](../docs/README.md) 第 2 节的清单里登记（**不要漏**，否则没人找得到）。
3. 检查是否触发第 5 节的同步规则表。
4. 若有设计层面的新决定 → 先写 ADR。

**检查点**

- [ ] 文档里没有出现服务方的**视觉标识资产**（[INV-4](INVARIANTS.md)）；
      项目名中的服务名是指示性使用，可以出现，但非官方声明必须在位
- [ ] 复述代码的地方改成了引用文件路径与函数名
- [ ] `docs/README.md` 已登记

---

## T9 · 引入一个新依赖

**步骤**

1. 回答 [`CONVENTIONS.md`](CONVENTIONS.md) 第 7 节的三问。任一答不上来就自己实现。
2. 是原生模块吗？是 → 必须说明对 deb / AppImage 与 arm64 构建的影响。
3. `pnpm run check` → `pnpm run verify`。
4. 若改变打包产物形态，更新 [`../docs/packaging.md`](../docs/packaging.md)。

**检查点**

- [ ] 运行时依赖数量没有无谓增长（当前只有 2 个，**这是一个特性**）
- [ ] 若为原生模块：`pnpm run verify` 通过，且在干净环境里实测

---

## T10 · 补一个单测

**步骤**

1. 判断被测逻辑能否脱离 Electron 运行。不能 → 先把逻辑抽成纯函数（这本身就是改进）。
2. 放 `test/unit/`，命名 `<模块>.test.ts`。
3. 优先覆盖边界与失效路径，而不是 happy path。

**检查点**

- [ ] 测试文件没有 `import ... from 'electron'`
- [ ] 至少覆盖一个"改坏了会挂"的边界情况
- [ ] `pnpm run test` 通过
