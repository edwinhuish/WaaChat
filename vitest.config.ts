import { defineConfig } from 'vitest/config'

/**
 * 单测配置。
 *
 * 唯一的硬约束来自 `ai/CONVENTIONS.md` 第 8 节：**单测不得加载 Electron**。
 * 因此这里固定 `environment: 'node'`（默认的 jsdom 环境反而会掩盖"某个模块偷偷
 * import 了 DOM 全局变量"这类问题），并且不引入任何 setup 文件。
 *
 * `include` 只匹配 `test/` 目录下的 `*.test.ts`，因此 `test/helpers/` 下的工具文件
 * 不会被当成测试文件执行，`test/e2e/` 里的产物冒烟测试也能共用这套配置。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    restoreMocks: true,

    /**
     * 逐个文件跑，不并行。
     *
     * 理由是**测试会改进程级状态**：`blobs.test.ts` 与 `store.test.ts` 都要把
     * `XDG_DATA_HOME` 指向自己的临时目录 —— 因为 `src/main/paths.ts` 是按环境变量
     * 推导归档位置的，那是它的正确行为。
     *
     * 而 `process.env` 是进程全局的。并行时两个文件会互相改掉对方的 XDG_DATA_HOME，
     * 症状是**偶发**失败：一个用例的归档文件出现在另一个用例的目录里（或反过来，
     * 统计到上一轮留下的文件）。偶发失败的测试比没有测试更糟 —— 它会训练出
     * "红了先重跑一次"的习惯。
     *
     * 说明：默认的分进程池（forks）下每个文件各占一个进程，实际不会撞上；
     * 但这条约束**不该依赖池的实现细节**，换个池或关掉 isolate 就会静默失效。
     * 代价可以忽略 —— 整套跑完不到 1 秒。
     */
    fileParallelism: false,
  },
})
