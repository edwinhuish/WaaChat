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
 * 解密由上游页面代码完成，我们只观察"解密完成之后"的结果 —— 这条判断有一个前提：
 * **我们自己不去实现它**，本守卫就是那个前提的看守。
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
      mediaKey: '不解析 mediaKey —— 包括页面对象上以该名字暴露的字段。',
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

/** 守卫管的是**我们的代码**（`src/`）。`scripts/` 与 `test/` 里出现这些词是自检与文档需要。 */
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
 * INV-1 / INV-2 的守卫（`ai/INVARIANTS.md`）：把两条被否决的技术路线编码成 CI 会红的东西，
 * 而不是靠评审者记得。放宽这里的任何一条都先写 ADR。
 *
 * INV-1 有一条**明示例外**：只读元数据求值 —— `capture/download.ts` 在下载前问页面一句
 * "这份内容的哈希 / 它属于哪个会话"（[ADR-0047](../../docs/decisions.md) /
 * [ADR-0055](../../docs/decisions.md)），以及 `dev-probe.ts` 在**未打包时**装一个只读探针
 * （[ADR-0046](../../docs/decisions.md)）。例外**不是**靠放宽 selector 得到的，而是在调用点用
 * 行内 `eslint-disable-next-line no-restricted-syntax` 显式声明 —— 每多一处都看得见。
 * 恢复约束与这条例外的来龙去脉见 [ADR-0057](../../docs/decisions.md)。
 *
 * 另有一条**独立的**进程边界在下面 RENDERER_SIDE 那段（G-1：渲染进程不得 import
 * `electron` / `node:fs` / `node:path`），它与这里的注入面是两回事。
 */
const invariantGuards = {
  'no-restricted-syntax': [
    'error',
    {
      selector: "MemberExpression[property.name='executeJavaScript']",
      message:
        'INV-1: 不在被承载的页面里求值脚本。只读元数据求值是唯一例外 —— 请在调用点行内 disable 并注明 ADR-0057。',
    },
    {
      selector: "MemberExpression[property.name='executeJavaScriptInIsolatedWorld']",
      message: 'INV-1: 同 executeJavaScript —— 附着到 Electron 内核层，不要在页面里跑脚本。',
    },
    {
      selector: "MemberExpression[property.name='insertCSS']",
      message: 'INV-1: 给远程页面注入样式同样是改页面。本地界面放 src/renderer，不要注入远程文档。',
    },
  ],
  'no-restricted-imports': [
    'error',
    {
      paths: [
        {
          name: 'puppeteer',
          message: 'INV-1: 浏览器自动化客户端整族都在范围之外。',
        },
        {
          name: 'puppeteer-core',
          message: 'INV-1: 浏览器自动化客户端整族都在范围之外。',
        },
        {
          name: 'puppeteer-in-electron',
          message: 'INV-1: 浏览器自动化客户端整族都在范围之外。',
        },
        {
          name: 'whatsapp-web.js',
          message: 'INV-1: 用 CDP 驱动页面是本项目拒绝的路线（引入它的计划已由 ADR-0057 放弃）。',
        },
        {
          name: 'wwebjs-electron',
          message: 'INV-1: 用 CDP 驱动页面是本项目拒绝的路线。',
        },
      ],
      patterns: [
        {
          group: ['*/baileys', '@whiskeysockets/*', 'whatsmeow*'],
          message: 'INV-2: 重实现传输协议被拒绝（见 docs/decisions.md ADR-0001）。',
        },
      ],
    },
  ],
}

/**
 * 把 INV-1 / INV-2 与 INV-3 的 `no-restricted-syntax` **拼进同一个 config 块**。
 *
 * 分成两个块会让后一个**整体覆盖**前一个 —— flat config 的同名规则键是"替换"不是"合并"。
 * 实测踩过：先写 invariantGuards 再写 cryptoGuards，INV-1 的 selector 静默失效、只有 INV-3 在跑，
 * 而那几处只读例外反被报成"Unused eslint-disable directive"。
 */
const projectGuards = {
  'no-restricted-syntax': [
    ...invariantGuards['no-restricted-syntax'],
    ...cryptoGuards['no-restricted-syntax'],
  ],
  'no-restricted-imports': invariantGuards['no-restricted-imports'],
}

export default new FlatConfigComposer()
  .append({
    ignores: [
      '**/node_modules/**',
      'out/**',
      'dist/**',
      'coverage/**',
      'build/**',
      '.workbuddy/**',
      /**
       * `.tmp/` 是**项目自己声明的**临时目录（`.gitignore` 里那一条：`/tmp` 是小 tmpfs 时
       * 用 `TMPDIR=$PWD/.tmp`），`pnpm run clean` 也会清它。里面放的是排查用的脚本与产物，
       * 不该按源码的标准 lint —— 而且它会让一次正常的 `pnpm run lint` 因为一份丢弃过一次的
       * 探针脚本而变红（实测：`node script.js` 里当然没有 `process` / `__dirname` 的类型信息）。
       */
      '.tmp/**',
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
  // INV-1 / INV-2 / INV-3：守卫全部落在 src/**，拼在一起发（见 projectGuards 的说明）。
  .append({
    files: PROJECT_CODE,
    rules: projectGuards,
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
