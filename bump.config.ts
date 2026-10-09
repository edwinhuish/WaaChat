import { defineConfig } from 'bumpp'

/**
 * 发布配置。`pnpm run release` → [`bumpp`](https://github.com/antfu-collective/bumpp)。
 *
 * 一次发布 = 提升 `package.json` 的版本 → 提交 → 打 `v<版本>` 标签 → 推送。
 * 标签推上去就会触发 `.github/workflows/release.yml`，而**这个动作不可回退**：
 * 产物一旦发布，删掉 Release 也收不回已经散出去的 `latest-linux.yml`。
 *
 * 用法：
 *   pnpm run release                          # 交互式选版本（patch / minor / major / 自定义）
 *   pnpm run release --release minor          # 直接指定版本类型，或直接给版本号（如 1.0.0）
 *   pnpm run release --release 1.0.0 --yes    # 非交互：连最后的确认也跳过（脚本里用）
 *
 * ⚠️ **不要**写成 `pnpm run release -- --release minor`（npm 时代的习惯）。
 * 本仓库钉死的 pnpm 12.10.1 会把 `--` **原样转发**给脚本 —— 实测 `pnpm run release -- --help`
 * 的回显是 `$ bumpp -- --help`，而 bumpp 只把「脚本名之后的裸参数」当 flag 解析：带 `--` 时
 * 那些 flag 会落到它的位置参数（文件名）上，于是版本参数不生效、弹出交互式版本选择器，
 * 最后还会去 bump 一个叫 `--release` 的文件。参数直接跟在脚本名后面即可。
 *
 * 发布前先在 `main` 上把 `CHANGELOG.md` 改好并提交 —— 步骤见 `ai/TASKS.md` T6。
 * 决策与取舍见 `docs/decisions.md` 的 ADR-0012。
 */
export default defineConfig({
  /**
   * 只碰 `package.json`。
   *
   * ⚠️ 绝不能把 `CHANGELOG.md` 加进来：bumpp 对"已知文件"之外的路径做的是
   * **旧版本号的全文替换**，而 CHANGELOG 里的版本号同时出现在小节标题、
   * 底部的 `[<版本>]:` 链接与 `[Unreleased]` 的 compare 起点中。全文替换会把已经
   * 发布出去的历史改写掉，而且不会报错 —— 属于"事后才会发现"的一类损坏。
   */
  files: ['package.json'],

  /**
   * 要求工作区干净。bumpp **默认不做**这项检查（默认 `noGitCheck: true`，
   * 命令行上对应 `--git-check`），这里显式打开。
   *
   * 理由：发布提交里应当只有"版本号"这一处改动。带着未提交的东西发版，标签指向的
   * 内容与发布者以为的不一致，而这件事只有等产物发出去之后才会被发现。
   *
   * ⚠️ 与 `all` 的耦合：bumpp 在 `all: true` 时会**跳过**这项检查（它要的就是把
   * 未提交的改动一并提交）。所以不要打开 `all`，否则这条守卫会静默失效。
   */
  noGitCheck: false,

  /**
   * `{tag}` 渲染成标签名 ⇒ `chore(release): v1.0.0`。
   * 这里写 `{tag}` 而不是再拼一遍 `v{version}`：标签格式只在下面定义一处。
   * （bumpp 12 起推荐具名 token；旧的 `%s` 仍可用，但已标记为软弃用。）
   */
  commit: 'chore(release): {tag}',

  /** ⇒ `v1.0.0`，与 release.yml 的 `on.push.tags: ['v*']` 对齐。 */
  tag: 'v{version}',

  /** 提交与标签一起推：少推任何一个都会让远端与代码分叉。 */
  push: true,
})
