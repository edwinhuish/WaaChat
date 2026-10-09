/**
 * 清理构建产物。
 *
 * 为什么不是 `rm -rf`：scripts 里的命令在任何跑 npm/pnpm script 的地方都会执行，
 * 而 `rm -rf` 是 shell 方言 —— 换个 shell 或换台机器就静默失效或误删。
 * 这段 Node 代码只有一种行为，且 `force: true` 让"目录本来就不存在"也算成功。
 *
 * 刻意**不**清理 node_modules：那是 `pnpm install` 的领地，混进来会让
 * "为什么删了依赖之后行为变了"这类问题变得难以复现。
 */

import { rmSync } from 'node:fs'

/** 都是构建/测试派生物，删掉不影响任何源文件。 */
const TARGETS = ['out', 'dist', 'coverage', 'node_modules/.vite', '.tmp']

for (const target of TARGETS) {
  rmSync(target, { recursive: true, force: true })
}

process.stdout.write(`clean: 已清理 ${TARGETS.join(' / ')}\n`)
