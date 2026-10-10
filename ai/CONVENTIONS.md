# 代码规范

约束的**优先级**：`INVARIANTS.md` > 本文件 > 个人偏好。冲突时按这个顺序。

---

## 1. 语言

| 对象 | 语言 | 说明 |
|---|---|---|
| 标识符（变量、函数、类型） | 英文 | |
| 代码注释 | 英文 | 注释解释**为什么**，不解释**是什么** |
| 提交信息 | `type(scope): 英文标题`，正文可中文 | |
| 文档（`docs/`、`ai/`、根目录 `.md`） | 中文 | 除代码片段 |
| 面向用户的界面文案 | 中文 | |
| 日志消息 | 英文 | 便于检索与聚合 |

## 2. 目录职责（不要越界）

| 目录 | 可以做 | 不可以做 |
|---|---|---|
| `src/shared/` | 纯类型、常量、无副作用的纯函数 | 导入 electron、访问文件系统、有状态 |
| `src/main/` | 一切本地能力 | 依赖具体界面形态 |
| `src/main/capture/` | 观察内核层事件、产出"文件 + 身份" | 解密、解析页面、决定存哪里 |
| `src/main/archive/` | 存储、索引、去重、淘汰 | 知道文件从哪来 |
| `src/main/integration/` | 交系统打开、托盘、应用图标（含用户级启动器条目） | 决定何时/是否存储、解码图片（那是渲染进程的事） |
| `src/preload/` | 白名单桥接，**单向** | 暴露"让页面发起本地动作"的能力 |
| `src/renderer/` | 自有界面 | 直接访问文件系统 |

**依赖方向**：`capture → archive`（可以），`archive → capture`（不可以）。`shared` 被所有人依赖，它不依赖任何人。

**一个刻意的例外**：图片解码与裁剪发生在 `src/renderer/`（canvas），而不是主进程 —— Electron 的
`nativeImage` 只保证 PNG / JPEG，而 ICO 只有 Chromium 的解码器认得。界面拿到的仍然是**字节**；
落盘位置、权限与启动器条目由 `src/main/integration/appicon.ts` 决定。见 ADR-0022。

## 3. TypeScript

- **严格模式已开启**，不要用 `@ts-ignore` / `as any` 绕过。用 `unknown` + 窄化代替。
- `verbatimModuleSyntax` 已开启：类型导入必须写 `import type { X } from ...`（ESLint 会自动修）。
- 优先 `readonly`、`as const`、可辨识联合，少用可选字段表示状态。
- 导出尽量窄：模块只导出别人真正要用的东西。
- **纯函数优先**。可单测的逻辑不要和 Electron API 混在一个文件里 ——
  `capture/cachekey.ts` 与 `archive/blobs.ts` 之所以与 Electron 无关，就是为了能被单测直接覆盖。

## 4. 错误处理

- 不使用空 `catch`。要么处理，要么带上上下文重新抛出。
- **外部输入（上游事件、URL、文件内容）一律视为不可信**，必须校验后再用。
- 可预期的失败（磁盘满、无关联应用）**不能**抛到顶层让应用崩；应降级并给用户可见的反馈（见 `docs/architecture.md` 第 5 节）。
- 降级必须**可见**。静默降级等同于缺陷。

## 5. 日志

```ts
// 可以
logger.info('archive: stored', { hash: hash.slice(0, 8), bytes, mime })

// 不可以：泄露文件名、会话名、完整路径
logger.info('archive: stored', { name: fileName, chat: chatName, path: absolutePath })
```

规则见 [`INVARIANTS.md`](INVARIANTS.md) G-3 与 [`../docs/security.md`](../docs/security.md) T4。
日志里需要标识一份文件时，用哈希前缀。

## 6. IPC

- 通道名集中在 `src/main/ipc/channels.ts`，主进程与渲染进程共享，不写字面量。
- 通道**按语义设计，不按参数设计**：
  ```ts
  // 对：渲染进程传的是主进程产生的标识
  invoke('archive:open', { id: 1234 })

  // 错：渲染进程传任意路径 —— 等于把文件系统开放给渲染进程
  invoke('fs:read', { path: '/anywhere' })
  ```
- 主进程侧注册处理器时校验 `event.senderFrame`，拒绝来自远程页面的调用。

## 7. 依赖

引入新依赖前先问三个问题，任一答不上来就不加：

1. 用标准库或已有依赖能否在**半天内**自己实现？（能 → 自己写）
2. 它是**原生模块**吗？（是 → 必须说明对 deb / AppImage 与跨架构构建的影响，见 G-5）
3. 它的**维护状态**如何？最近一次发布在多久以前？

运行时依赖目前只有两个（`better-sqlite3`、`electron-updater`）。**保持这个量级是一个特性，不是巧合。**

## 8. 测试

- 单测放 `test/unit/`，**不得加载 Electron**。要测主进程逻辑，就把逻辑抽成不依赖 Electron 的纯函数。
- 夹具放 `test/fixtures/`。⚠️ 夹具的**宿主不一定是 Node** —— 例如
  `probe-media-metadata.js` 是要**粘贴进页面控制台**运行的探针，宿主是浏览器，因此
  `eslint.config.mjs` 给它的是 browser globals（见 `PAGE_CONTEXT_FIXTURE`）。别顺手把它挪进 `src/`。
- 必须覆盖的边界：内容寻址的去重与冲突、幂等键对各类 URL 的推导、淘汰策略的边界、FTS 查询。
- 不追求覆盖率数字。追求"**改坏了会被测出来**"。

## 9. 提交信息

[Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <英文标题，祈使句，不超过 72 字符>

<可选的正文，可用中文，说明为什么>

<可选的 footer：Closes #12 / BREAKING CHANGE: ...>
```

`type`：`feat` `fix` `refactor` `docs` `test` `chore` `build` `ci` `perf`
`scope`：`capture` `archive` `ipc` `ui` `packaging` `ci` `docs` `adr`

`ui` 覆盖本地界面的形态：窗口、托盘菜单、渲染层的入口与视图。它此前不在表里，于是窗口/托盘
类改动只能挑 `ipc` 或 `capture` —— 两个都不准（ADR-0025 把本地界面拆成两扇窗口时补上的）。

一个提交做一件事。重构与功能改动**不要**混在一起 —— 那会让 review 与回滚都变难。

## 10. 文档同步

改 `docs/` 必须在同一 PR 同步对应的 `ai/`，反之亦然。规则表见 [`../docs/README.md`](../docs/README.md) 第 5 节。

**设计变更先写 ADR，再写代码。** 不要只把理由写在提交信息或 PR 描述里 —— 那些会被埋掉。
