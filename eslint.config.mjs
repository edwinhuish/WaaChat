import js from '@eslint/js'
import { FlatConfigComposer } from 'eslint-flat-config-utils'
import unusedImports from 'eslint-plugin-unused-imports'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const NODE_SIDE = [
  'src/main/**/*.ts',
  'src/preload/**/*.ts',
  'src/shared/**/*.ts',
  // 构建/维护脚本是 Node 侧的。**两种扩展名都要列** —— 只写 `*.ts` 会让
  // `scripts/*.mjs` 落到"没有任何 globals"的裸配置上，`process` 直接被判
  // `no-undef`（真实踩过：scripts/clean.mjs）。
  'scripts/**/*.{ts,mjs}',
  'test/**/*.ts',
  '*.config.ts',
]

const RENDERER_SIDE = ['src/renderer/**/*.ts', 'src/shared/**/*.ts']

/**
 * INV-1 与 INV-2 的守卫曾落在这里（`no-restricted-syntax` 拦 `executeJavaScript` /
 * `insertCSS`，`no-restricted-imports` 拦 puppeteer 家族 / `whatsapp-web.js` / 协议库）。
 *
 * **已由 [ADR-0043](../../docs/decisions.md) 撤销** —— 项目改用 `whatsapp-web.js` 承载会话与媒体，
 * 那两条约束与承载方式不再兼容，因此整段移除（撤销的完整理由与迁移清单见该 ADR）。
 *
 * 仍然生效的边界是**渲染进程的进程边界**（G-1，见下面 RENDERER_SIDE 那段）：渲染进程不得
 * import `electron` / `node:fs` / `node:path`。那不是本次要动的约束。
 */

export default new FlatConfigComposer()
  .append({
    ignores: [
      '**/node_modules/**',
      'out/**',
      'dist/**',
      'coverage/**',
      'build/**',
      '.workbuddy/**',
    ],
  })
  .append({
    files: ['**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
  })
  /**
   * `eslint:recommended`（核心规则）必须显式启用。
   *
   * 它**不在** typescript-eslint 的 recommended 里：后者只带来 TS 相关的规则。
   * 少了这一层，`no-unreachable` / `no-dupe-keys` / `no-constant-condition` /
   * `no-control-regex` 这类基础正确性检查全是关着的 —— 这类漏洞不会报错，
   * 只会一直存在到某天有人踩上去。
   *
   * 必须排在 typescript-eslint 之前：TS 那套会关掉被自己取代的核心规则
   * （如 `no-unused-vars`），顺序反了会把它们又打开，变成同一条规则报两遍。
   */
  .append(js.configs.recommended)
  .append(...tseslint.configs.recommended)
  .append({
    files: NODE_SIDE,
    languageOptions: { globals: { ...globals.node } },
  })
  .append({
    files: RENDERER_SIDE,
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'Rendering-side code must reach the main process through the preload bridge (src/preload/index.ts). Importing electron here would require nodeIntegration.',
            },
            {
              name: 'node:fs',
              message: 'Filesystem access belongs to the main process, behind an IPC channel.',
            },
            {
              name: 'node:path',
              message: 'Filesystem access belongs to the main process, behind an IPC channel.',
            },
          ],
        },
      ],
    },
  })
  .append({
    plugins: { 'unused-imports': unusedImports },
    rules: {
      'unused-imports/no-unused-imports': 'error',
      /**
       * 显式重配 `@typescript-eslint/no-unused-vars`。
       *
       * 不配的话它用的是 typescript-eslint 的默认值（**没有**下划线豁免），
       * 于是 `_unused` 这种"我明确知道它现在没用"的写法仍然会被判错。
       * 保持与 unused-imports 的选项一致，两条规则才不会对同一行给出不同结论。
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'unused-imports/no-unused-vars': [
        'warn',
        { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      eqeqeq: ['error', 'smart'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  })
  // 构建期脚本是命令行工具，它的输出**就是** console.log。
  // 应用代码里禁止 console 是为了不绕过 logger（脱敏约定），那条理由在这里不成立。
  .append({
    files: ['scripts/**/*.{ts,mjs}'],
    rules: { 'no-console': 'off' },
  })
  .append(prettier)
  .toConfigs()
