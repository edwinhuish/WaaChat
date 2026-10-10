# 文档地图与目录结构

找不到东西时，从这份文件开始。

---

## 1. 先搞清楚三份"宪法"级文档

仓库里有三份文档地位高于其他所有文档。它们各自回答一个不同的问题，**不要合并它们**：

| 文档 | 回答的问题 | 谁必须读 | 改动门槛 |
|---|---|---|---|
| [`../DISCLAIMER.md`](../DISCLAIMER.md) | 做这件事**合不合规**，风险在哪 | 所有人 | 高，需要 PR 说明理由 |
| [`../ai/INVARIANTS.md`](../ai/INVARIANTS.md) | 技术上**绝对不能做什么** | 所有改代码的人 | 高，需要 ADR |
| [`decisions.md`](decisions.md) | 为什么**选了这个而不是那个** | 所有人 | 中，追加而非修改 |

其余文档都是这三份的**展开或摘要**。冲突时以它们为准。

## 2. 文档清单

### 面向用户

| 文档 | 用途 | 什么时候读 |
|---|---|---|
| [`usage.md`](usage.md) | 安装、首次链接设备、日常使用、归档位置、排障 | 第一次装，或遇到"点文件没反应" |
| [`../DISCLAIMER.md`](../DISCLAIMER.md) | 风险与合规基线 | **安装之前** |

### 面向开发者

| 文档 | 用途 | 什么时候读 |
|---|---|---|
| [`architecture.md`](architecture.md) | 分层架构、数据流、模块职责边界 | 第一次读代码之前 |
| [`media-capture.md`](media-capture.md) | 核心机制：下载接管、密文缓存、幂等键设计、脆弱点 | 改动 `src/main/capture/` 之前 |
| [`security.md`](security.md) | 威胁模型、落盘内容的权限与生命周期 | 改动任何落盘路径之前 |
| [`packaging.md`](packaging.md) | deb / AppImage 构建细节、桌面集成、已知的坑 | 改 `electron-builder.yml` / `build/` / `.github/workflows/` 之前 |
| [`decisions.md`](decisions.md) | 决策记录（ADR），含被否决的方案与理由 | 想推翻某个设计之前（**先读，再提**） |
| [`roadmap.md`](roadmap.md) | 里程碑、验收标准、当前进度 | 想知道先做什么 |
| [`research/inv3-assessment.md`](research/inv3-assessment.md) | INV-3 的抽样审计：任何承载方式下，解密都不在我们手里 | 评估承载方式（驱动型客户端库）时 |
| [`research/browser-runtime-assessment.md`](research/browser-runtime-assessment.md) | 承载/浏览器从哪来：能不能换成 Playwright、或复用已有浏览器 | 评估承载方式时 |
| [`research/early-file-identity.md`](research/early-file-identity.md) | 从"点击"到"Blob"的完整流程；能否在下载前拿到内容身份以跳过下载与哈希 | 评估"自建客户端 + 早期去重"之前 |
| [`research/runtime-migration-assessment.md`](research/runtime-migration-assessment.md) | 宿主运行时：能不能把 Electron 换成 Tauri / Wails / 其它；两个接管点各依赖内核的什么能力 | 评估"换宿主 / 换框架 / 减小体积"之前 |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | 开发流程、分支与提交规范、PR 清单 | 提 PR 之前 |

### 面向 AI 助手

| 文档 | 用途 |
|---|---|
| [`../AGENTS.md`](../AGENTS.md) | **入口**：一页纸的硬约束 + 文档路由。必须完整读完 |
| [`../ai/CONTEXT.md`](../ai/CONTEXT.md) | 项目上下文与术语表 |
| [`../ai/CONVENTIONS.md`](../ai/CONVENTIONS.md) | 代码、命名、提交规范 |
| [`../ai/INVARIANTS.md`](../ai/INVARIANTS.md) | 硬约束及**自查方式** |
| [`../ai/TASKS.md`](../ai/TASKS.md) | 常见任务的分步操作手册 |

> **为什么 `docs/` 与 `ai/` 并存？** 同一份事实，两种读者需要不同的组织方式。人需要"为什么"和背景，AI 需要"禁止什么"和"怎么做"。把它们写在一份文档里，两侧都会读得不舒服。代价是**必须同步**，规则见第 5 节。

## 3. 目录结构

```
waachat/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                  PR 校验：静态检查 + 打包并断言产物
│   │   └── release.yml             打 v* 标签 → 构建 → 上传 Release + 校验值
│   ├── scripts/
│   │   ├── get-tags.sh             找出上一个版本标签（发布说明的对比起点）
│   │   └── generate-changelog.sh   由提交历史生成发布说明（Release body）
│   ├── ISSUE_TEMPLATE/             三类模板（缺陷 / 接管失效 / 功能建议）
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── dependabot.yml              依赖更新；含 typescript 的版本上限约束
│
├── ai/                             ← 给 AI 的操作手册（人可读，但不是主要读者）
│   ├── CONTEXT.md                  上下文、术语表
│   ├── CONVENTIONS.md              编码与提交规范
│   ├── INVARIANTS.md               硬约束 + 自查方式
│   └── TASKS.md                    常见任务操作手册
│
├── build/                          ← 打包资源（不是源码，不参与编译）
│   ├── icon.svg                    图标矢量源文件（唯一事实源）
│   ├── icon.png                    由 icon.svg 生成，打包时使用
│   ├── apparmor/waachat              AppImage 用户手动安装的 AppArmor profile
│   └── waachat.desktop               参考用的桌面条目（仅供对照，实际由 electron-builder 生成）
│
├── docs/                           ← 给人看的文档
│   ├── README.md                   本文件：地图 + 结构 + 同步规则
│   ├── architecture.md             分层架构与数据流
│   ├── media-capture.md            核心机制与脆弱点
│   ├── security.md                 威胁模型
│   ├── packaging.md                打包与分发
│   ├── decisions.md                决策记录（ADR）← 唯一事实源
│   ├── roadmap.md                  里程碑
│   ├── usage.md                    使用说明
│   └── research/                   立项期研究材料（只增不改，作为历史记录）
│
├── scripts/                        ← 构建与校验脚本（由 package.json 的 scripts 调用）
│   ├── verify-package.sh           解包产物并断言桌面集成正确
│   ├── check-capture.ts            接管健康自检（离线，不启动 Electron）
│   ├── make-icons.sh               由 SVG 生成 PNG
│   └── clean.mjs                   清理 out/ dist/ coverage/ 等构建产物
│
├── src/
│   ├── main/                       ← Electron 主进程：唯一有权限碰文件系统的地方
│   │   ├── index.ts                应用入口：生命周期、单实例、app_id、退出清理
│   │   ├── window.ts               窗口创建、UA 改写、两扇本地窗口的引用
│   │   ├── session.ts              会话分区、协议层与下载层的注册入口
│   │   ├── settings.ts             配置持久化 + 进程内实时读取
│   │   ├── logger.ts               日志（含敏感信息脱敏约定）
│   │   ├── errors.ts               失败原因取 errno（fs 错误的 name 恒为 `Error`，说不清处境）
│   │   ├── notice.ts               主动提示用户：系统通知 + 节流（接管失效）
│   │   ├── account.ts              账号标识：读页面记下的 WID / `wa_ul` cookie（ADR-0039）
│   │   ├── paths.ts                目录布局：归档位置、账号层次目录、缓存根与索引路径
│   │   ├── permissions.ts          权限白名单（来源 + 类型，双向；纯模块可单测，见 T5）
│   │   ├── linux-gpu.ts            Wayland 启动期的 GPU 开关（ADR-0036 / ADR-0038）
│   │   ├── dev-probe.ts            **仅开发模式**：把只读探针注入聊天窗口（ADR-0046）
│   │   ├── dev-probe-source.ts     它的路径与注入代码（纯函数，可单测）
│   │   ├── capture/                ★ 核心：内核层接管
│   │   │   ├── cachekey.ts         幂等键推导（纯函数，可单测）
│   │   │   ├── cache-files.ts      缓存条目形态 + 转换/暂存区/启动对账 + 容量上限与 LRU 淘汰（ADR-0049，不导入 electron）
│   │   │   ├── cache-switch.ts     切换开关的事务编排：转换 → 提交 → 收尾，失败回退
│   │   │   ├── download.ts         下载事件接管 → 归档 + 打开
│   │   │   ├── early-identity.ts   下载前的对账：读消息模型的 filehash，命中归档就打开并作废这次下载（ADR-0047）；另按哈希反查会话ID（ADR-0055）
│   │   │   ├── protocol.ts         会话协议拦截 → 密文磁盘缓存
│   │   │   ├── headers.ts          回放缓存时保留哪些响应头（白名单；漏一个会静默坏页面）
│   │   │   ├── retry.ts            连接层失败（`ERR_CONNECTION_RESET` 一类）的有限重试（ADR-0033）
│   │   │   └── health.ts           接管失效的事实源（markCaptured / markFailure / onHealthChange）
│   │   ├── archive/                ★ 核心：本地归档（账号 / 会话ID 分层，见 ADR-0055）
│   │   │   ├── blobs.ts            归档落盘：原文名命名 + <账号>/<会话ID>/files/ 分层 + 只读 + 去重（硬链接）+ 清扫、淘汰（ADR-0048）
│   │   │   ├── naming.ts           文件名净化 + 同名冲突的候选名（纯函数，安全关键，可单测）
│   │   │   ├── layout.ts           账号 × 会话分区：会话ID / 账号净化与容器判据、相对路径净化（纯函数，可单测）
│   │   │   ├── store.ts            SQLite 索引（FTS5 全文搜索）+ 按内容淘汰（enforceLimit，ADR-0048）
│   │   │   ├── delete.ts           批量删除：去掉选中的记录，删完收掉空容器（ADR-0053 / ADR-0054）
│   │   │   ├── export.ts           批量导出：把正文副本写到用户选的目录（ADR-0050）
│   │   │   ├── migrate.ts          归档迁移：整库搬到新位置，失败回滚
│   │   │   ├── relocate.ts         换保存位置：把"搬数据"与"落设置"绑成一次原子操作（ADR-0019）
│   │   │   └── schema.sql          表结构
│   │   ├── ipc/
│   │   │   ├── channels.ts         通道名常量（主进程与渲染进程共享）
│   │   │   └── index.ts            通道注册 + 调用方与参数校验
│   │   └── integration/            系统集成
│   │       ├── appicon.ts          应用图标：读写、贴到窗口与托盘、启动器条目覆盖
│   │       ├── open.ts             交给默认应用打开 / 在文件管理器中定位
│   │       ├── login.ts            开机自启（含 AppImage 的路径陷阱）
│   │       └── tray.ts             托盘图标（Ayatana）
│   │
│   ├── preload/
│   │   └── index.ts                contextBridge：只暴露白名单 API，单向取数据
│   │
│   ├── renderer/                   ← 本地界面（无框架，纯 DOM；两扇窗口各一个入口，见 ADR-0025）
│   │   ├── files.html              「文件列表」窗口：结构 + CSP
│   │   ├── files.ts                它的装配（只挂文件列表）
│   │   ├── settings.html           「设置」窗口：结构 + CSP
│   │   ├── settings.ts             它的装配（只挂设置项；顶栏已去掉，见 ADR-0042）
│   │   ├── fatal.ts                装配失败的兜底提示（两个入口共用）
│   │   ├── bridge.ts               取 window.waachat（拿不到就抛）
│   │   ├── env.d.ts                window.waachat 的类型声明
│   │   ├── dom.ts                  h() / part()：让 textContent 成为最省事的写法
│   │   ├── icon.ts                 用 canvas 把图片裁成 512×512（解码在渲染进程，见 ADR-0022）
│   │   ├── styles.css
│   │   └── views/
│   │       ├── archive.ts          文件列表窗口的主体（含搜索竞态处理）
│   │       └── settings.ts         偏好设置（含应用图标；行序与容量上限的状态提示见下）
│   │
│   └── shared/                     ← 主进程与渲染进程共享的纯类型/常量（不含副作用）
│       ├── action-button.ts        设置行里动作按钮的视觉属性（一个来源，两处按钮因此一致）
│       ├── appicon.ts              图标尺寸/上限、裁剪几何、桌面条目生成（纯函数，可单测）
│       ├── cache-conversion.ts     密文缓存切换失败的文案（只有一份，主进程与界面共用）
│       ├── constants.ts            上游地址、分区名、app_id、容量上限
│       ├── deletion.ts             批量删除的确认与失败文案（纯函数，可单测）
│       ├── export.ts               批量导出的失败文案（纯函数，可单测）
│       ├── types.ts                数据形状 + 默认设置 + 需重启的项
│       ├── bridge.ts               渲染侧能看到的全部能力（纯类型）
│       ├── format.ts               字节/时间格式化、失败原因的人话翻译
│       ├── migration.ts            归档迁移的进度与失败文案（纯函数，可单测）
│       ├── notice.ts               主动提示用户的文案与判据：接管失效（纯函数，可单测）
│       ├── settings-sections.ts    设置窗口的区域与行序（数据；每个设置项恰好一行）
│       ├── size-limit.ts           容量上限的状态文案：按"当前值 + 是否已实现"算出来（纯函数，可单测）
│       ├── upstream.ts             "上游域"判据：站内/站外与权限来源（解析 URL 后比 host / origin）
│       ├── user-agent.ts           UA 构造（纯函数，可单测）
│       └── vite-assets.d.ts        `?raw` 导入的类型声明
│
├── test/
│   ├── helpers/sqlite.ts           子进程里的原生模块探测（加载 + 建库 + 真实 schema，决定 sqlite 用例是否跳过）
│   ├── fixtures/                   页面探针等夹具（宿主是浏览器，不是 Node —— 见 ai/CONVENTIONS.md 第 8 节）
│   ├── unit/                       纯逻辑单测，不加载 Electron
│   └── e2e/                        产物冒烟测试（不启动 Electron，需先 pnpm run build）
│
├── AGENTS.md                       ← AI 入口（根目录，便于自动发现）
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
├── DISCLAIMER.md
├── CHANGELOG.md
├── LICENSE
│
├── package.json                    ← 唯一的命令入口：scripts 就是全部任务
├── pnpm-lock.yaml                  ← 依赖锁文件（pnpm；不要用 npm 生成第二个）
├── pnpm-workspace.yaml             ← pnpm 项目级设置（依赖构建脚本白名单 allowBuilds）
├── electron.vite.config.ts         三个 bundle 的编译配置
├── electron-builder.yml            打包配置（deb / AppImage）
├── eslint.config.mjs               lint，并在此固化架构不变量
├── vitest.config.ts                单测配置（node 环境，禁止加载 Electron）
├── tsconfig.json                   main / preload / shared / scripts / test
└── tsconfig.web.json               renderer + shared
```

**读这份结构的三条要点**：

1. **`src/main/` 是唯一有权限碰文件系统与系统调用的地方。** 渲染进程与远程页面都必须经过 IPC。
2. **`capture/` + `archive/` 是项目的全部价值所在**，其余都是脚手架。评审时把注意力放这两处。
3. **`build/` 是资源不是源码**，不参与编译；`scripts/` 是构建期工具，不进入产物。

## 4. 文档之间的派生关系

```
                    docs/decisions.md  ← 唯一事实源（为什么）
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
  DISCLAIMER.md        architecture.md      ai/INVARIANTS.md
  （合规边界）          media-capture.md     （技术红线）
        │                    │                    │
        └────────────┬───────┴──────────┬─────────┘
                     ▼                  ▼
              docs/usage.md        AGENTS.md
              （用户后果）          （AI 路由 + 检查清单）
```

- **下游文档只做展开，不引入新决定。** 想改设计 → 改 `decisions.md`，再顺着箭头改下游。
- `ai/INVARIANTS.md` 是 `decisions.md` 中「被否决方案」的技术化表达：ADR 说"为什么不走那条路"，INVARIANTS 说"所以代码里不许出现什么"。
- `DISCLAIMER.md` 是同一批决定的**对外后果**：因为这些技术选择，用户承担哪些风险。

## 5. 同步规则

改动必须连带修改哪些文件：

| 你改了 | 必须同时更新 |
|---|---|
| 任一 ADR（`decisions.md`） | 受影响的 `architecture.md` / `media-capture.md` / `INVARIANTS.md` |
| 硬约束（`INVARIANTS.md`） | `AGENTS.md` 第 1 节、`eslint.config.mjs` 的守卫规则、`DISCLAIMER.md` 的风险表 |
| 落地路径或落盘内容 | `security.md` 的资产表 + `usage.md` 的归档位置说明 |
| 打包配置 / 依赖 | `packaging.md` + `AGENTS.md` 的"已知的坑"表 |
| 用户可见行为 | `usage.md` + `CHANGELOG.md` |
| `docs/` 任意内容 | 对应的 `ai/` 文档（反之亦然） |

这些不是"最好做到"，是 PR 检查清单里逐条勾的项目。

## 6. 写作约定

- **语言**：文档用中文；代码、标识符、注释、配置文件、提交信息用英文。
- **一份文档只回答一个问题**。要回答第二个问题就新开一份，然后在本文档里登记。
- **写"为什么"，不写"是什么"**。"是什么"由代码和 `--help` 回答。
- **不要复述代码**。引用文件路径与函数名，让读者去看。代码变了文档不会腐坏。
- **`docs/research/` 只增不改**。它是历史记录，反映了当时的判断；后续结论变了，在 `decisions.md` 里记录，不要回去改研究文档。
