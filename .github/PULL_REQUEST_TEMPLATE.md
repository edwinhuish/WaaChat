## 这个 PR 做了什么

<!-- 一到三句话。如果这个 PR 在修一个缺陷，说清触发条件。 -->

## 类型

- [ ] 缺陷修复
- [ ] 新功能
- [ ] 重构（无行为变化）
- [ ] 文档
- [ ] 打包 / CI / 依赖

## 检查清单

- [ ] `pnpm run check` 通过
- [ ] 涉及打包、桌面集成、图标或依赖 → `pnpm run verify` 通过
- [ ] **没有**触碰 [ai/INVARIANTS.md](../ai/INVARIANTS.md) 里的硬约束（被 ESLint 拦下时**没有**改 lint 配置）
- [ ] 设计变更已在 [docs/decisions.md](../docs/decisions.md) 追加 ADR，而不是只写在提交信息里
- [ ] 改了 `docs/` 就在同一 PR 同步了对应的 `ai/`（反之亦然）
- [ ] 没有提交任何服务方的**视觉标识资产**（Logo / 图标 / 字体 / 官方配色）；非官方声明仍在 `README.md` 与 `DISCLAIMER.md` 里
- [ ] 新增用户可见行为 → 已更新 [docs/usage.md](../docs/usage.md)

## 需要评审者特别关注的地方

<!-- 例如：缓存键的边界情况、上游行为变化时的降级路径、新的落盘内容及其权限 -->

## 截图 / 输出

<!-- UI 改动给截图；打包改动给 `pnpm run verify` 的输出 -->
