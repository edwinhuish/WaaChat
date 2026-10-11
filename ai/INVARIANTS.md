# 硬约束（INVARIANTS）

> 与 [`../AGENTS.md`](../AGENTS.md) 第 1 节保持同步。这里是**可执行版本**：每条都给了自查方式。
> 改动本文件需要先追加 ADR（见 `../docs/decisions.md`）。

四条硬约束对应四条被否决的技术路线。它们不是为了"好看"而立的规矩，每一条都排除掉一整类风险。

> **现状**：四条**全部生效** —— INV-1 与 INV-2 曾被 [ADR-0043](../docs/decisions.md#adr-0043) 撤销，
> 已由 [ADR-0057](../docs/decisions.md#adr-0057) 恢复。其中 INV-1 附带一条**只读元数据例外**
> （见下）。它曾经还有过一条"'按用户的选择写下上游自己那条语言偏好 cookie'的写入例外"
> （[ADR-0065](../docs/decisions.md#adr-0065)），**已由 [ADR-0066](../docs/decisions.md#adr-0066) 撤销**：
> 实测证明网页版的语言由**账号**决定，我们写下的那条 cookie 会在几秒内被页面改回去。

---

## INV-1 · 绝不向被承载的页面注入脚本

**状态**：**已生效**（曾被 [ADR-0043](../docs/decisions.md#adr-0043) 撤销，由
[ADR-0057](../docs/decisions.md#adr-0057) 恢复），**附带一条只读例外**（见下）。

**陈述**：不使用 `webContents.executeJavaScript`、`executeJavaScriptInIsolatedWorld`、
`insertCSS`；不让 preload 直连页面世界（`contextIsolation: false`）；不通过调试协议（CDP）驱动页面；
不引入浏览器自动化库（puppeteer 家族、whatsapp-web.js 家族）。

**只读例外**：允许**只读地**在页面里求值一个表达式，取回消息模型上的元数据（`filehash`、
`msg.id.remote`）—— 不得解析 DOM、不得驱动页面动作、不得给承载窗口加 preload；每个调用点必须在行内
声明（`eslint-disable-next-line no-restricted-syntax`，注明 [ADR-0057](../docs/decisions.md#adr-0057)）。
当前只有两处：`capture/download.ts`（下载前问内容哈希与会话ID）与 `dev-probe.ts`（仅开发模式的只读
探针，[ADR-0046](../docs/decisions.md#adr-0046)）。

**为什么**：本项目的立身之本是"页面里跑的东西与上游逐字节一致" —— ⚠️ 这条例外的存在已经让该**强表述**
不再成立（见 [ADR-0057](../docs/decisions.md#adr-0057) 的"已知限制"）；但约束的实质仍然成立：**不主动
注入、不改页面行为、不给远程内容任何本地能力**。一旦全面注入，产品性质就从"宿主进程"变成"修改过的
客户端"。

**例外仍然是注入面**：取回的值只留在主进程侧使用，**绝不回传页面**（T1 的判断在这里同样适用）。

**不算注入的两类做法**（判据是同一个：*我们有没有往页面里写东西、有没有给远程内容新能力*）：

- **改请求头**：UA 这类"在请求层面表现得像一个普通浏览器"的做法（[ADR-0060](../docs/decisions.md#adr-0060)
  决定 4，**仍生效**）。它一个字节都不进页面，页面里跑的东西仍与上游逐字节一致。⚠️ 由此而来的**会话级**
  设置今天只有 UA：`Accept-Language` 与启动期的 `--lang` 曾经也用它落地「界面语言」，两者都已随那一项
  一起撤掉（[ADR-0063](../docs/decisions.md#adr-0063) → [ADR-0066](../docs/decisions.md#adr-0066)）。
  ⚠️ 而**覆盖 `navigator.language` 本身**那一类做法（往页面里塞脚本改 `navigator`）**不在此列**。
- **用内核自己的既有能力**：拼写检查（[ADR-0061](../docs/decisions.md#adr-0061)）连页面都不碰 ——
  红线由渲染进程自己画，纠错建议是主进程弹出的原生菜单。

⚠️ 反过来，"**改了页面已经渲染出来的东西**"无论用什么手段（`insertCSS`、`executeJavaScript`、
CDP）都还是注入，上面几条不是它们的挡箭牌。

⚠️ **"清掉它的存储逼它重来"同样不在此列** —— 那是把一个我们没有选择权的东西删掉、赌它自己会重建。
（[ADR-0065](../docs/decisions.md#adr-0065) 因此没有采用"删掉那条语言 cookie、让它重新按
`navigator.language` 挑"这条更省事的路：它要重启才生效，而且删的是用户没要求删的东西；
[ADR-0066](../docs/decisions.md#adr-0066) 又复核了一遍，结论不变。）

⚠️ **今天这份文档里没有任何"写进页面存储"的口子。** 曾经有过一条 —— 按用户的显式选择写下上游那条
语言偏好 cookie（[ADR-0065](../docs/decisions.md#adr-0065)）—— 已由
[ADR-0066](../docs/decisions.md#adr-0066) 撤销（实测：页面会在几秒内按**账号语言**把它改回去）。
`pnpm run selfcheck` 第 19 节因此断言 `src/` 里不出现 `cookies.set(` / `cookies.remove(` ——
这条负向断言就是为了不让它悄悄回来。若将来有人要重新开这样的口子，那等于"**我们替用户决定上游的
状态**"（哪怕只是一小步、哪怕看起来更方便），产品性质就是
[ADR-0057](../docs/decisions.md#adr-0057) 所说的"修改过的客户端"。**改任何一条守卫之前，先在
`docs/decisions.md` 追加 ADR。**

**自查**：

```bash
# 应当只列出那两处只读求值（每一处都带 eslint-disable 与 ADR-0057 的注解）：
rg -n 'executeJavaScript' src/
# 除下面两处，其余任何一处都是越界：
#   src/main/capture/download.ts（filehash / 会话ID 反查）
#   src/main/dev-probe.ts（仅开发模式的只读探针）
rg -n "from '(puppeteer|puppeteer-core|puppeteer-in-electron|whatsapp-web\.js|wwebjs-electron)'" src/
# 应当无输出：今天没有任何地方往页面存储里写东西（写入例外已由 ADR-0066 撤销）：
rg -n 'cookies\.(set|remove)\(' src/
```

---

## INV-2 · 绝不重实现传输协议

**状态**：**已生效**（曾被 [ADR-0043](../docs/decisions.md#adr-0043) 撤销，由
[ADR-0057](../docs/decisions.md#adr-0057) 恢复）。

**陈述**：不引入 whatsmeow、Baileys、WPPConnect、Venom 之类的协议库；不自行实现握手、密钥协商、
消息编解码。会话与加解密继续由官方网页版代码承担。

**为什么**：见 [ADR-0001](../docs/decisions.md#adr-0001)。协议级客户端的能力缺口是结构性的
（无音视频通话、应用状态只读、广播列表不支持），且是被重点识别的一类客户端 —— 这条与承载方式
无关，因此没有理由放弃它。

**自查**：

```bash
# 应当无输出：
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
- `pnpm run selfcheck` 第 15 节：对 `src/` 做一次同样的文本扫描（含上述标识符），并对
  `package.json` 断言**没有**在 Node 侧解密的库。lint 拦"写法"，自检拦"结果 + 依赖"。

**一条明确的禁止项**：**不读取以 `mediaKey` 命名的字段**（含页面对象上的公开属性）—— 写下它的那一刻
就已经是"解析 mediaKey"。这条来自 [ADR-0045](../docs/decisions.md#adr-0045) 的加固，其抽样审计见
[`../docs/research/inv3-assessment.md`](../docs/research/inv3-assessment.md)。那次审计写于"打算接入
驱动型客户端库"之时，那条计划已由 [ADR-0057](../docs/decisions.md#adr-0057) 放弃，但**加固本身不变**。

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
