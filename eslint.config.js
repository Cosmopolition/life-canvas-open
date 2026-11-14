// ESLint 9 flat config。
//
// 取向：**只抓真问题，不做风格管制**。
// 格式统一交给 Prettier（.prettierrc.json），所以这里一条 stylistic 规则都不开 ——
// 开了就会跟仓库里已有的 1.5 万行代码大面积打架（而那些代码本身没问题）。
//
// ⚠️ 这个文件**暂时不参与 CI**：eslint / prettier 还没进 package.json 的依赖。
//    装上之后加一条 "lint": "eslint ." 就能接进去（见 README「代码规范」）。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'macos/**', // Swift 原生壳，不是 TS
      'shots/**',
      'promo/**',
      'docs/**',
      // tools/ 在 tsconfig 的 include 之外（include 只有 src/scripts/tests/vite.config.ts），
      // 类型感知规则要求文件属于某个 tsconfig —— 不排除掉会直接报解析错误。
      'tools/**',
    ],
  },
  {
    // 只查 .ts。仓库根目录的 e2e.cjs / stress.cjs 和 scripts/*.mjs 是
    // 一次性脚本，没进 tsconfig，也没必要按 TS 规则去查。
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      // —— 真问题（会挡住合并）——
      // 宽松相等。null: 'ignore' 是为了放过 `x == null`
      // （同时判 null 和 undefined 的惯用写法，仓库里 timeline-view.ts 有一处）。
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // 无用表达式：只查真正的死代码。
      // allowTernary 是为了放过 `cond ? a.delete(x) : a.add(y);` 这种
      // **故意**用三元做副作用的写法（src/app.ts 里有 3 处，是既有风格）。
      '@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true }],

      // —— 只告警，不挡门 ——
      // 未使用的变量/参数。
      // ⚠️ 只告警、不挡门，理由有二：
      //   ① tsconfig 的 noUnusedLocals / noUnusedParameters 已经在 CI 里
      //      当 error 把关（npm run typecheck），这条是补漏，不是主闸门；
      //   ② 现有代码有 1 处真的死变量（src/export/review-card.ts 的 `y`，
      //      累加了但从来没读过）。清掉那两行之后可以升回 error。
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
      // 显式 any：现在仓库里一处都没有（实测），但这是"想让人别再写"的信号，
      // 不是"现在有人写错了"。
      '@typescript-eslint/no-explicit-any': 'warn',
      // console：调试用，别当成错误。
      'no-console': 'warn',

      // —— 明确关掉的风格规则 ——
      // prefer-const：纯风格（`let` → `const`），现有代码有 4 处。
      // 风格归 Prettier 管，eslint 只抓 bug。
      'prefer-const': 'off',
    },
  },
  {
    // 类型感知的规则：需要 tsconfig，慢一点，但能抓"忘了 await 的 Promise"。
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        // projectService 会给每个被查文件找到它最近的 tsconfig.json，
        // 不用手写 project 路径，也不会因为新增目录就失效。
        projectService: true,
      },
    },
    rules: {
      // 悬空的 Promise：忘了 await / 没 .catch()。
      // 只告警 —— 这类规则依赖类型推断，误报率比别的规则高。
      '@typescript-eslint/no-floating-promises': 'warn',
    },
  },
);
