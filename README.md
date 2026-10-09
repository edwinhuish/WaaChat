# WaaChat

> ⚠️ **个人自用封装 · 非官方应用 · 与任何官方组织无关**
>
> 本项目由个人独立开发、**仅供自用**：没有商业支持，也不承诺任何形式的可用性。
> 它与任何官方组织**没有任何隶属、授权、背书、赞助或关联关系**，不代表任何官方立场，
> 也不是官方客户端。它承载官方的网页版页面，但除此之外与官方无关 —— 请不要把它
> 当成官方产品。完整说明见 [`DISCLAIMER.md`](DISCLAIMER.md)。

> Linux 桌面聊天客户端外壳 + 本地媒体库。**在聊天记录里点击文件，直接打开，不用先下载。**

`deb` / `AppImage` 双格式分发 · Electron + Chromium 内核层接管 · 页面零注入

---

## 它解决什么问题

官方从未发布 Linux 桌面客户端；用网页版时，每次想看一个聊天里的文件，都得走一遍：

**点文件 → 等浏览器下载 → 去 `~/Downloads` 找 → 手动双击打开**。

更麻烦的是：网页版的媒体链接带有会过期的签名，**链接一过期，那个文件就永远打不开了**。

WaaChat 把这条链路压成一步：

```
点击文件  →  （首次）解密并归档 /（之后）直接读本地  →  交给系统默认应用打开
```

具体到行为：

| 场景 | 网页版 | WaaChat |
|---|---|---|
| 首次点开一个 PDF | 下载到 `~/Downloads`，手动打开 | 直接弹出系统 PDF 阅读器 |
| 再次点开同一个文件 | 再下载一遍，`报告 (1).pdf` | 读本地归档，零网络，瞬时 |
| 转发到另一个会话后再点 | 再下载一遍，`报告 (2).pdf` | 内容哈希命中，仍只存一份 |
| 文件从未打开过 | — | 可选后台预取，点开时已在本地 |
| 原链接已过期 | 「此文件已不可用」 | 归档仍在，照常打开 |
| 想找半年前群里的附件 | 靠聊天记录滚动翻 | 归档可搜文件名 |

## 它**不是**什么

这几条是项目的硬边界，不是待办事项（见 `ai/INVARIANTS.md`）：

- **不是**协议重实现。不解析、不模拟、不重传任何私有协议。
- **不是**自动化机器人。不注入页面脚本、不驱动调试协议、不自动收发消息。
- **不是**解密工具。不接触密钥协商，不修改加密流量；解密只发生在官方网页代码内部。

它做的事更接近：**给官方网页版配一个看得懂"下载"这件事的宿主进程**。

---

## 快速开始

### 作为用户

从 [Releases](https://github.com/edwinhuish/waachat/releases) 下载并安装：

```bash
# Debian / Ubuntu（把下面两处的版本号换成你下载的那个）
sudo apt install ./waachat_1.0.0_amd64.deb

# 或者用 AppImage（免安装）
chmod +x WaaChat-1.0.0.AppImage
./WaaChat-1.0.0.AppImage
```

首次启动后用手机扫码链接设备即可。详细说明见 [`docs/usage.md`](docs/usage.md)。

### 作为开发者

需要 Node.js ≥ 24.21（见 `.nvmrc`）和 pnpm ≥ 12（见 `package.json` 的 `packageManager`）。没装 pnpm 的话，`corepack enable` 之后它会按 `packageManager` 自动就位。

所有任务都定义在 `package.json` 的 `scripts` 里 —— **没有第二个入口**，本地跑的命令与 CI 跑的同名同实现。

```bash
pnpm install         # 装依赖（postinstall 顺带拉 Electron 二进制）
pnpm run dev         # 开发模式
pnpm run check       # 提交前：lint + 格式 + 类型检查 + 单测 + 离线接管自检
pnpm run verify      # 完整构建 deb + AppImage，并校验产物
```

全部脚本（含单独打 deb / AppImage、重画图标、清理产物）见 [`AGENTS.md`](AGENTS.md) 第 2 节。

## 架构一览

```
Electron 壳（Chromium 内核）
├── 承载官方网页版            ← 页面 JS 一行不改
├── 内核层 · 下载事件接管      ← 明文落盘 + 立即打开
├── 内核层 · 会话协议拦截      ← 密文磁盘缓存（默认关闭，可在设置里开启），二次打开零网络
├── 归档索引（SQLite + FTS5）  ← 去重、搜索、淘汰策略
└── 系统集成                 ← xdg-open / 托盘
```

展开说明与数据流：[`docs/architecture.md`](docs/architecture.md)。
接管机制的原理、幂等键设计与已知脆弱点：[`docs/media-capture.md`](docs/media-capture.md)。

---

## 文档地图

这个仓库有两套并列的文档，服务两类读者。**它们不是重复，是同一份事实的两个视图。**

| 文件 | 面向 | 用途 |
|---|---|---|
| [`README.md`](README.md) | 所有人 | 5 分钟理解项目是什么、怎么跑起来 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 贡献者 | 开发流程、提交规范、PR 检查清单 |
| [`DISCLAIMER.md`](DISCLAIMER.md) | 所有人 | **合规基线**：商标、服务条款、封号风险、明文落盘 |
| [`SECURITY.md`](SECURITY.md) | 所有人 | 威胁模型与漏洞报告流程 |
| [`docs/README.md`](docs/README.md) | 所有人 | 文档地图 + 目录结构逐条说明（**从这里找东西**） |
| [`docs/architecture.md`](docs/architecture.md) | 开发者 | 分层架构、数据流、模块职责 |
| [`docs/usage.md`](docs/usage.md) | 用户 | 安装、首次链接、日常使用、排障 |
| [`docs/packaging.md`](docs/packaging.md) | 维护者 | deb / AppImage 构建细节与已知坑 |
| [`docs/media-capture.md`](docs/media-capture.md) | 开发者 | 接管机制原理、缓存键设计、脆弱点 |
| [`docs/decisions.md`](docs/decisions.md) | 所有人 | **决策记录（ADR）—— 唯一事实源** |
| [`docs/roadmap.md`](docs/roadmap.md) | 所有人 | 里程碑与当前状态 |
| [`docs/research/feasibility-study.md`](docs/research/feasibility-study.md) | 所有人 | 立项前的可行性研究原文（含被否决的方案） |
| [`AGENTS.md`](AGENTS.md) | **AI** | AI 操作入口：硬约束 + 文档路由 |
| [`ai/CONTEXT.md`](ai/CONTEXT.md) | **AI** | 项目上下文、术语表 |
| [`ai/CONVENTIONS.md`](ai/CONVENTIONS.md) | **AI** + 贡献者 | 代码、命名、提交规范 |
| [`ai/INVARIANTS.md`](ai/INVARIANTS.md) | **AI** + 贡献者 | 不可违背的红线及自查方式 |
| [`ai/TASKS.md`](ai/TASKS.md) | **AI** | 常见任务操作手册 |

**相互关系，一句话版**：

- `docs/decisions.md` 是**唯一事实源**。架构文档、README、AI 文档都只是它的展开或摘要；三者冲突时以决策记录为准。
- `docs/` 是**给人看的**，`ai/` 是**给 AI 看的**。二者的内容必须一致 —— 改了一侧就在同一个 PR 里改另一侧。
- `AGENTS.md` 在仓库根目录，因为多数 AI 工具只会自动读取根目录下的同名文件；它本身很短，只是路由表 + 红线。

---

## 当前状态

**早期开发中。** 里程碑与各阶段验收标准见 [`docs/roadmap.md`](docs/roadmap.md)。

## 免责声明

**本项目是个人自用封装，非官方应用，与任何官方组织无关。** 它由个人独立开发、不提供
任何担保或支持，与 Meta Platforms, Inc. 及其关联公司**无任何隶属、授权、背书或赞助
关系**，也不代表任何官方立场。

它承载该服务官方的网页版，但**不包含、也不使用**其任何图标、字体或配色资产；项目名
本身不含服务方名称，亦不主张任何商标权利。使用第三方客户端可能违反服务条款，存在
账号被限制的风险；解密后的明文会落盘。

**开始使用前请读 [`DISCLAIMER.md`](DISCLAIMER.md)。**

## 许可

[MIT](LICENSE)
