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
 * INV-3 的守卫（`ai/INVARIANTS.md`）：**我们自己的代码不经手密钥与加密**。
 *
 * 为什么现在才加：接入 `whatsapp-web.js` 之前必须回答"解密还在不在我们手里"。抽样审计的结论是
 * **在** —— 解密由上游页面代码（`msg.downloadMedia()`）完成，该库自身不含对称解密实现（逐条证据
 * 与作废条件见 `docs/research/inv3-assessment.md`）。那条结论有一个前提：**我们自己不去实现它**。
 * 本守卫就是那个前提的看守。
 *
 * 只禁"写法"，不禁"能力"：`createHash` 是允许的例外（内容寻址用 sha256，见 INV-3 的说明）。
 * 依赖那一半 —— 在 **Node 侧**解密的库会让解密离开上游 —— lint 拦不住，由 `pnpm run selfcheck`
 * 对依赖清单断言；两条一起才守得住。
 *
 * ⚠️ `filehash` **已从这个列表里移出**（[ADR-0047](../../docs/decisions.md)）：真机实测表明
 * `msg.filehash` 是**文件明文的 SHA-256**（与归档里的 `hash` 逐字节相同），不是密钥派生的
 * HMAC —— 原判定的前提（[ADR-0045](../../docs/decisions.md)）被推翻。`mediaKey` 与全部解密
 * 原语**不在放宽之列**：INV-3 的实质未变，只是允许读一个我们本就能自己算出来的内容哈希。
 */
const cryptoGuards = {
  'no-restricted-syntax': [
    'error',
    ...Object.entries({
      createDecipheriv: '不做对称解密 —— 解密由官方页面代码完成。',
      createDecipher: '不做对称解密 —— 解密由官方页面代码完成。',
      createCipheriv: '不做对称加密。',
      createCipher: '不做对称加密。',
      createHmac: '不做认证码运算。',
      hkdf: '不实现密钥派生。',
      subtle: '不碰 WebCrypto（crypto.subtle）。',
      mediaKey: '不解析 mediaKey —— 包括不读取该库暴露的 Message.mediaKey 字段。',
    }).map(([name, reason]) => ({
      /**
       * 用 `Identifier` 而不是 `MemberExpression`：`o.mediaKey` 与 `import { mediaKey } …`
       * 两种写法都要拦 —— 只匹配成员访问会让解构导入整条溜过去。
       */
      selector: `Identifier[name='${name}']`,
      message: `INV-3: ${reason}（见 docs/research/inv3-assessment.md）`,
    })),
  ],
}

/** INV-3 管的是**我们的代码**（`src/`）。`scripts/` 与 `test/` 里出现这些词是自检与文档需要。 */
const PROJECT_CODE = ['src/**/*.ts']

/**
 * `test/fixtures/**` 下的脚本，宿主是**浏览器**而不是 Node。
 *
 * 典型的是 `probe-media-metadata.js`：一段**粘贴进页面控制台**运行的探针，它引用
 * `window` / `console`，还依赖 `Uint8Array` 的跨realm 行为（见 `test/unit` 里那份单测）。
 * 缺了这段，它会落到"没有任何 globals"的裸配置上被判 `no-undef` —— 和
 * `scripts/*.mjs` 当年踩的是同一个坑（见上面 NODE_SIDE 的注释）。
 *
 * ⚠️ 这**不是**网开一面：给的是**正确**的 globals，因此把 `window` 拼错成 `windw`
 * 照样会被 `no-undef` 抓到；改成在文件头禁用 `no-undef` 才会丢掉这层保护。
 */
const PAGE_CONTEXT_FIXTURE = ['test/fixtures/**/*.js']

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
  // 页面上下文的夹具：宿主是浏览器，见 PAGE_CONTEXT_FIXTURE 的说明。
  .append({
    files: PAGE_CONTEXT_FIXTURE,
    languageOptions: { globals: { ...globals.browser } },
  })
  // INV-3：我们自己的代码不经手密钥与加密（解密由上游页面代码完成）。
  .append({
    files: PROJECT_CODE,
    rules: cryptoGuards,
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
  // 页面上下文的夹具同理：探针的全部产出就是给人看的控制台输出。
  // 应用代码里禁止 console 是为了不绕过 logger（脱敏约定），那条理由在这里都不成立。
  //
  // ⚠️ 必须放在**通配所有文件**的那个块之后 —— 反了会被它重新打开（踩过一次）。
  .append({
    files: ['scripts/**/*.{ts,mjs}', ...PAGE_CONTEXT_FIXTURE],
    rules: { 'no-console': 'off' },
  })
  .append(prettier)
  .toConfigs()
