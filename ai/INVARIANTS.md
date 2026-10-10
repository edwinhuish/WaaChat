# 硬约束（INVARIANTS）

> 与 [`../AGENTS.md`](../AGENTS.md) 第 1 节保持同步。这里是**可执行版本**：每条都给了自查方式。
> 改动本文件需要先追加 ADR（见 `../docs/decisions.md`）。

四条硬约束对应四条被否决的技术路线。它们不是为了"好看"而立的规矩，每一条都排除掉一整类风险。

> **现状（[ADR-0043](../docs/decisions.md#adr-0043)）**：**INV-1 与 INV-2 已撤销**（项目改用
> `whatsapp-web.js`）；仍生效的是 **INV-3 与 INV-4**。被撤销的两节保留在下面，作为历史说明。

---

## INV-1 · ~~绝不向被承载的页面注入脚本~~（**已撤销**）

**状态**：**已由 [ADR-0043](../docs/decisions.md#adr-0043) 撤销**。现行路线以 `whatsapp-web.js`
承载会话与媒体，而该库本身就通过调试协议（CDP）驱动页面，因此本约束及其 ESLint 守卫都已移出
（`eslint.config.mjs` 的 `invariantGuards` 里那段 `no-restricted-syntax`）。

**原陈述**（历史，保留以便追溯）：不使用 `webContents.executeJavaScript`、
`executeJavaScriptInIsolatedWorld`、`insertCSS`；不让 preload 直连页面世界
（`contextIsolation: false`）；不通过调试协议（CDP）驱动页面；不引入浏览器自动化库
（puppeteer 家族、whatsapp-web.js 家族）。

**原理由**：本项目的立身之本是"页面里跑的东西与上游逐字节一致"。一旦注入，这条立论消失，
产品性质从"宿主进程"变成"修改过的客户端"。**该立论随承载方式改变而失效**，这是撤销的依据。

**原自查**（历史；下面的命令如今**应当有输出**，不再代表违规）：

```bash
rg -n 'executeJavaScript|insertCSS|contextIsolation:\s*false|webSecurity:\s*false' src/
rg -n "from '(puppeteer|puppeteer-core|puppeteer-in-electron|whatsapp-web\.js|wwebjs-electron)'" src/
```

---

## INV-2 · ~~绝不重实现传输协议~~（**已撤销**）

**状态**：**已由 [ADR-0043](../docs/decisions.md#adr-0043) 撤销**。现行路线允许依赖网页版内部 API
与协议驱动型客户端库；`eslint.config.mjs` 里那段 `no-restricted-imports` 已随之移除。

**原陈述**（历史）：不引入 whatsmeow、Baileys、WPPConnect、Venom 之类的协议库；不调用网页版的
内部 API；不自行实现握手、密钥协商、消息编解码。

**原理由**：见 [ADR-0001](../docs/decisions.md#adr-0001)。协议级客户端的能力缺口是结构性的
（无音视频通话、应用状态只读、广播列表不支持），且是被重点识别的一类客户端。
**该风险已由项目所有者明确接受**（[ADR-0043](../docs/decisions.md#adr-0043) 理由 3）。

**原自查**（历史；如今**应当有输出**，不再代表违规）：

```bash
rg -n "whatsmeow|baileys|@whiskeysockets|WPPConnect|venom" --glob '!docs/**' --glob '!ai/**' .
rg -n 'WAWeb|window\.Store|internalStore' src/
```

---

## INV-3 · 绝不经手密钥与加密

**陈述**：不解析 mediaKey、不实现密钥派生、不做 AES / HMAC 运算、不修改加密流量。
解密只发生在官方网页代码内部。

**为什么**：见 [ADR-0007](../docs/decisions.md#adr-0007)。"使用公开算法解密自己有权访问的内容"
与"实现一个解密器"在代码上是同一件事，在定性上完全不同。而且技术上完全没有必要 ——
页面已经解密过了，我们只需观察下载事件拿到明文。

**自查**：

```bash
# 这些导入不应出现在 src/ 下（Node 内置 crypto 用于计算内容哈希是允许的）
rg -n "createDecipher|createCipher|hkdf|Hkdf|subtle\.decrypt|mediaKey" src/
rg -n "from 'node:crypto'" src/     # 允许，但用途只能是 sha256（内容寻址）
```

**允许的例外**：对**明文**计算 SHA-256 用于内容寻址（`archive/blobs.ts`）。
这是完整性校验，不是密码学运算，也不接触任何密钥。

**强制**：

- ESLint 的 `cryptoGuards`（`eslint.config.mjs`，作用于 `src/**`）：禁止
  `createDecipher*` / `createCipher*` / `createHmac` / `hkdf` / `subtle` / `mediaKey` / `filehash`。
- `pnpm run selfcheck` 第 16 节：对 `src/` 做一次同样的文本扫描（含上述标识符），并对
  `package.json` 断言**没有**在 Node 侧解密的库。lint 拦"写法"，自检拦"结果 + 依赖"。

**接口在承载方式改变后的加码**：接入 `whatsapp-web.js` 后，解密仍由上游页面代码
（`msg.downloadMedia()`）完成 —— 抽样审计见 [`../docs/research/inv3-assessment.md`](../docs/research/inv3-assessment.md)。
但该库把 `this.mediaKey = data.mediaKey` 作为 `Message` 的**公开属性**暴露，因此本约束多一条明确的
禁止项：**不读取 `Message.mediaKey`**（写下它的那一刻就已经是"解析 mediaKey"）。

---

## INV-4 · 绝不使用服务方的视觉标识资产

**陈述**：不使用 WhatsApp / Meta 的 Logo、图标、字体、吉祥物、官方配色，也不用其任何素材充当应用图标。
由此产生一条**强制义务**：非官方声明必须同时出现在 `README.md`、`DISCLAIMER.md` 与安装产物中。

**为什么**：见 [ADR-0020](../docs/decisions.md#adr-0020)（现行）与 [ADR-0011](../docs/decisions.md#adr-0011)（历史）。
本项目当前的名称 `WaaChat` **不含**服务方名称，因此名称不再需要"指示性使用"这条辩护，
它曾经承担的那部分商标风险随之消解。但**声明义务不跟着退休**：这个名字与知名服务高度近似，
而这个应用本身就是承载该服务网页版的宿主 —— 用户会把"非官方"当成需要被告知的事。
让声明随改名一起消失，等于把风险留给最不设防的那个人（下载了 deb 却以为是官方客户端的人）。

视觉资产始终留在禁止项，与名称无关：它成本为零、混淆风险最高，是真正可避免的那部分。

**自动化**：`pnpm run selfcheck` 断言**四处**声明都在位 —— README 顶部、DISCLAIMER、
`electron-builder.yml` 里会进**安装产物**的两份（deb 的 `synopsis` 与 `.desktop` 的 `Comment`），
以及运行期生成的那份**用户级启动器条目**（`shared/appicon.ts` 的 `buildDesktopEntry()`，
见 [ADR-0022](../docs/decisions.md#adr-0022) —— 它会取代安装时那份条目，因此义务跟着一起走）。
声明消失属于"静默失效"那一类：改配置时顺手删掉一行，谁也不会发现，
而用户装完之后可能永远不会打开 README。

**自查**：

```bash
# 应当无输出：仓库里不应出现任何服务方的二进制素材
rg -i --files build/ src/renderer/ | grep -iE 'logo|whatsapp.*\.(png|svg|ico|jpg|woff)'

# 应当有输出：非官方声明必须在位（README、DISCLAIMER、以及安装产物里的那份）
rg -l -i 'not affiliated|无任何隶属|非官方' README.md DISCLAIMER.md
rg -n -i 'unofficial' electron-builder.yml
```

**四处身份声明必须一致**（`package.json` 的 `desktopName`、`electron-builder.yml` 的
`linux.syncDesktopName`（决定产物 `.desktop` 的**文件名**）与其
`linux.desktop.entry.StartupWMClass`、`src/main/index.ts` 的 `app.setDesktopName()`）
—— `pnpm run verify` 会**同时**断言文件名与 `StartupWMClass`。
漏掉 `syncDesktopName` 时文件名会退化成 `<executableName>.desktop`，而 `StartupWMClass`
仍然正确，所以只断言 WMClass 抓不到。理由见 `docs/packaging.md` 第 2 节。
AppArmor profile 的文件名与声明名也必须与 `executableName` 同源，理由见 `build/apparmor/waachat` 的注释。

---

## 次级约束

以下是**可以讨论**的工程约定，违反需要理由，但不需要 ADR。

| 编号 | 约束 | 理由 | 自查 |
|---|---|---|---|
| G-1 | 渲染进程不直接访问文件系统，一律经 IPC | 权限集中，易评审 | renderer 下不出现 `node:fs` / `node:path` 导入（ESLint 已拦） |
| G-2 | preload 只提供**单向**数据通道，不提供"让页面发起本地动作"的能力 | 远程内容触达本地能力是 T1 攻击面 | preload 暴露的方法**全部是读**或**经主进程校验的明确操作**，不接受任意路径参数 |
| G-3 | 日志不写文件名全文、会话名、消息内容、绝对路径的用户名段 | 见 [`docs/security.md`](../docs/security.md) T4 | 记录日志处只用哈希前缀或相对目录名 |
| G-4 | 归档目录内不跟随符号链接 | 防路径穿越 | `archive/blobs.ts` 的写入用随机临时名 + `rename`；**淘汰**只处理索引给出的名字，且用 `lstat` 判断（不是 `stat`）—— 见 [ADR-0048](../docs/decisions.md#adr-0048) |
| G-5 | 新增原生依赖必须说明它对 deb / AppImage 打包的影响 | 原生依赖引入跨架构构建与 prebuild 可用性问题；优先选 Node-API 模块以避免 ABI 耦合 | 见 [`docs/packaging.md`](../docs/packaging.md) 第 6 节 |
| G-6 | `typescript` 锁在 6.0.x | `typescript-eslint` 的 peer 要求 `<6.1.0` | `dependabot.yml` 已忽略 `>=6.1.0` |
