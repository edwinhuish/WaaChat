# 贡献指南

感谢有兴趣参与。这份文档说明**流程**；具体规范在 [`ai/CONVENTIONS.md`](ai/CONVENTIONS.md)，硬约束在 [`ai/INVARIANTS.md`](ai/INVARIANTS.md)。

**动手之前请先读 [`AGENTS.md`](AGENTS.md)** —— 它是本仓库最短、最全的规则入口，人类和 AI 都适用。

---

## 1. 环境准备

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 24.21（见 `.nvmrc`） | `nvm use` 即可 |
| pnpm | ≥ 12（见 `package.json` 的 `packageManager`） | 没装的话 `corepack enable` 之后会自动按该版本就位 |
| Linux | 任意现代发行版 | AppImage **只能在 Linux 上构建** |

```bash
git clone https://github.com/edwinhuish/waachat.git
cd waachat
pnpm install
pnpm run dev
```

`pnpm install` 的 `postinstall` 会跑 `install-electron` 拉取 Electron 二进制。这一步是项目自己补的：
**Electron 44 起该包不再自带 `postinstall`**（registry 上该版本 `scripts` 为 `null`），只留了一个
`install-electron` bin —— 不补的话 `pnpm run dev` 会报 "Electron failed to install correctly"。
卡在国内网络时见 `.npmrc` 里的镜像开关。

**不需要**原生模块的 ABI 兜底步骤：`better-sqlite3@13` 是 Node-API 模块，Node 与 Electron 共用同一份
`prebuilds/*.node`（实测），因此没有 `install-app-deps` 这一步 —— 见 [`docs/packaging.md`](docs/packaging.md) 第 6 节。

> 全部可用脚本见 [`AGENTS.md`](AGENTS.md) 第 2 节。`package.json` 的 `scripts` 是**唯一**入口 —— 没有 Taskfile，也没有第二套命令体系。

## 2. 提交前必做

```bash
pnpm run check     # lint + 格式 + 类型检查 + 单元测试 + 离线接管自检
```

改动了打包配置、`.desktop`、图标、权限、依赖时，**额外**跑：

```bash
pnpm run verify    # 完整构建 deb + AppImage，并校验产物
```

`pnpm run verify` 会实际解包产物并断言：`.desktop` 里的 `StartupWMClass` 与代码一致、图标存在、依赖字段合理、AppImage 不依赖 libfuse2。这些是"本地跑得好好的、装到别人机器上图标变齿轮"这类问题的拦截网。

## 3. 分支与提交

- 从 `main` 切分支：`feat/…`、`fix/…`、`docs/…`、`chore/…`
- 提交信息用 [Conventional Commits](https://www.conventionalcommits.org/)：
  ```
  feat(capture): 按内容哈希跳过重复落盘
  fix(packaging): 修正 StartupWMClass 与 app_id 不一致
  docs(adr): 记录不引入原生依赖的理由
  ```
  正文里可以用中文，标题的 `type(scope)` 用英文。
- 一个 PR 做一件事。**不要**把重构和新功能混在一起。

## 4. 设计变更：先写 ADR，再写代码

如果改动涉及**选型或取舍**（换库、换架构、放弃某个方案、新增系统权限），流程是：

1. 在 [`docs/decisions.md`](docs/decisions.md) 追加一条编号 ADR，写清：背景 / 决定 / 理由 / 被否决的替代方案 / 影响
2. PR 里先只提这条 ADR，等讨论
3. 达成一致后再提实现

**不要**把设计理由只写在 commit message 或 PR 描述里 —— 那些东西会被埋掉。

## 5. Pull Request 检查清单

- [ ] `pnpm run check` 通过
- [ ] 涉及打包 / 桌面集成 / 依赖 → `pnpm run verify` 通过
- [ ] 没有触碰 [`ai/INVARIANTS.md`](ai/INVARIANTS.md) 里的硬约束（被 ESLint 拦下时**不要**改 lint 配置）
- [ ] 设计变更已补 ADR
- [ ] `docs/` 与 `ai/` 的对应内容已同步
- [ ] 没有提交任何服务方的**视觉标识资产**（Logo / 图标 / 字体 / 官方配色）。
      项目名里的服务名是指示性使用，允许保留，但非官方声明必须同时出现在 `README.md` 与 `DISCLAIMER.md`
- [ ] 新增用户可见行为 → 已更新 [`docs/usage.md`](docs/usage.md)

## 6. 代码评审关注点

按优先级：

1. **合规**：有没有更接近"卸载客户端 + 自动化"的写法？（INV-1 / INV-2）
2. **安全**：新增的落盘内容是什么？权限对吗？有没有把敏感路径写进日志？
3. **健壮性**：上游行为变了会怎样？是**静默失效**还是**报错/降级**？静默失效不可接受。
4. **正确性**：缓存键、去重哈希、淘汰策略的边界情况。
5. **可维护性**：是否只依赖标准内核行为，而不是上游内部结构。

## 7. 报告问题

- 功能缺陷 / 崩溃 → [issue 模板](.github/ISSUE_TEMPLATE/)
- 安全或隐私问题 → **不要开公开 issue**，见 [`SECURITY.md`](SECURITY.md)
- 「接管失效了」（点了没反应 / 又跑进 `~/Downloads`）→ 请附上 `pnpm run selfcheck` 的输出、`pnpm run verify` 的输出（若产物相关）与系统信息，这类问题通常需要复现环境

## 8. 行为准则

参与本项目即表示同意遵守 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。
