import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

/**
 * Flat ESLint config. Harness pillars enforced here (docs/backend/01 §3, shared/09 §2.2):
 *   1. eslint-plugin-boundaries — DDD four-layer dependency rules (error level).
 *   2. no-restricted-syntax — bans new Date() / Date.now() / crypto.randomUUID()
 *      (Clock / IdGenerator ports, 25 §1.4) AND `as unknown as` double casts
 *      (parity with the frontend repo; forces honest type narrowing).
 * Both are `error` and CI runs with --max-warnings=0, so violations cannot merge.
 */

// `x as unknown as Y` — banned everywhere, tests included (parity with frontend).
const NO_AS_UNKNOWN_AS = {
  selector:
    "TSAsExpression[expression.type='TSAsExpression'][expression.typeAnnotation.type='TSUnknownKeyword']",
  message: '禁止 as unknown as 双重断言 —— 用正当类型收窄替代（与前端仓库一致）。',
};

/**
 * e2e 里禁止手抄 app 的全局装配 —— 必须走 `configurePlatformApp()`。
 *
 * ⚠️ 这条不是风格洁癖，它挡的是一个**已经发生过**的失效：`main.ts` 装三样
 * （prefix / 管道 / `ErrorEnvelopeFilter`），而 20 个 e2e 里有 19 个各自手抄了前两样。
 * 少的那一样正是把错误响应归一成信封的那层，于是**每个 e2e 断言的错误形状都不是
 * 生产上会出现的形状**。`passcode.e2e-spec.ts` 里一直写着
 * `expect(locked.body.code).toBe('PASSCODE_LOCKED')`，实测：不装 filter ⇒ 5 passed，
 * 装上 ⇒ `expected 'BAD_REQUEST' to be 'PASSCODE_LOCKED'`。断言从头就在，
 * 是 app 少装一层让它失效的——用户因此在解锁页看到「Http Exception」而门禁全绿。
 *
 * 手抄意味着 20 次可以漏的机会。共用函数让偏差没有落脚点，这条规则让**下一次手抄**
 * 在 lint 阶段就停下，而不是等某个真实用户看见一句机器话。
 */
const NO_HANDROLLED_APP_SETUP = ['setGlobalPrefix', 'useGlobalPipes', 'useGlobalFilters'].map(
  (m) => ({
    selector: `CallExpression[callee.property.name='${m}']`,
    message: `e2e 不要手抄 app 装配：用 configurePlatformApp(app)（bootstrap/configure-app.ts）。漏掉 ErrorEnvelopeFilter 会让错误信封断言测到一个生产上不存在的形状。`,
  }),
);

/**
 * `SANDBOX_DEFAULT_IMAGE` 只许在 `shared-kernel/domain/builtin-image.ts` 里读一次。
 *
 * ⚠️ 这条挡的是一个**已经发生过**的分裂：同一个 env 曾被三处各自读取，兜底值却是
 * 两个不同的值（`ghcr.io/agent-infra/sandbox:latest` vs `alpine:3.20`）。于是没配这个
 * env 时，开机日志说「把 SANDBOX_DEFAULT_IMAGE 指向平台预制镜像」，而向导对用户说
 * 「镜像 `alpine:3.20` 尚未注册，请先注册它」——**两条提示指向两个不同的下一步**，
 * 而用户看得见的那条是错的：他会去注册一张 alpine，那张镜像既没有 agent 也没有 tmux，
 * 注册完照样用不了。全量测试 883 条**一条都没红**，因为没有任何断言在比对这三处。
 *
 * 用 `builtinImageRef()`（`@platform/shared-kernel`）。
 */
const NO_SCATTERED_DEFAULT_IMAGE = {
  selector:
    "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='SANDBOX_DEFAULT_IMAGE']",
  message:
    '不要各自读 SANDBOX_DEFAULT_IMAGE —— 用 builtinImageRef()（@platform/shared-kernel）。三处各读一次曾经分裂出两个不同的兜底值，把用户指向了错误的下一步。',
};

// time / random bans — exempted only in port implementations and tests.
const NO_DIRECT_TIME_RANDOM = [
  {
    selector: "NewExpression[callee.name='Date']",
    message: 'Use the Clock port — new Date() is banned (01 §3 / 25 §1.4).',
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'Use the Clock port — Date.now() is banned (01 §3 / 25 §1.4).',
  },
  {
    selector: "CallExpression[callee.property.name='randomUUID']",
    message: 'Use the IdGenerator port — crypto.randomUUID() is banned (01 §3).',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
      'drizzle/**',
      'coverage/**',
      // ⚠️ 运行期数据根（DATA_ROOT 默认 ./data）。CI 是干净检出、这个目录不存在，
      // 所以少了这一条 CI 照样绿；但**本机跑过后端之后**，里面是沙箱工作区和 git
      // 基线（别人的仓库源码），`pnpm lint` 会被几百个与本仓无关的错淹掉 —— 实测
      // 339 个。而「本地检查必须对齐 CI」是本仓反复强调的纪律，一个本地必红、CI 必
      // 绿的 lint 等于把这条纪律废掉：人会开始忽略 lint 的红。
      'data/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: { boundaries },
    settings: {
      'import/resolver': {
        typescript: {
          project: [
            'packages/shared-kernel/tsconfig.json',
            'packages/contracts/tsconfig.json',
            'packages/modules/project/tsconfig.json',
            'packages/modules/sandbox/tsconfig.json',
            'packages/modules/credential/tsconfig.json',
            'packages/modules/runtime/tsconfig.json',
            'packages/modules/image/tsconfig.json',
            'apps/api/tsconfig.json',
          ],
        },
        node: true,
      },
      // Each element captures its bounded-context module name (`module`) so the
      // rules below can forbid CROSS-CONTEXT internal imports, not just cross-LAYER
      // ones (P1-1). The composition-root module file is matched FIRST (order
      // matters) so it is NOT treated as `interface` — it is the one place a port
      // is wired to its impl.
      'boundaries/elements': [
        {
          type: 'module-root',
          mode: 'file',
          pattern: 'packages/modules/*/src/interface/*.module.ts',
          capture: ['module'],
        },
        { type: 'domain', pattern: 'packages/modules/*/src/domain/**', capture: ['module'] },
        {
          type: 'application',
          pattern: 'packages/modules/*/src/application/**',
          capture: ['module'],
        },
        {
          type: 'infrastructure',
          pattern: 'packages/modules/*/src/infrastructure/**',
          capture: ['module'],
        },
        { type: 'interface', pattern: 'packages/modules/*/src/interface/**', capture: ['module'] },
        { type: 'shared-kernel', pattern: 'packages/shared-kernel/**' },
        { type: 'contracts', pattern: 'packages/contracts/**' },
      ],
      'boundaries/ignore': ['**/*.spec.ts', '**/*.e2e-spec.ts', '**/test/**'],
    },
    rules: {
      // `{ module: '${from.module}' }` pins each intra-module layer allowance to the
      // SAME bounded context. Importing another module's domain/application/etc.
      // internal files matches an element of a DIFFERENT module → no rule allows it
      // → error. Cross-context collaboration must go through the module's public
      // `src/index.ts` (a non-element path, hence unrestricted) — i.e. `@platform/*`.
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            {
              from: 'module-root',
              allow: [
                ['domain', { module: '${from.module}' }],
                ['application', { module: '${from.module}' }],
                ['infrastructure', { module: '${from.module}' }],
                ['interface', { module: '${from.module}' }],
                'contracts',
                'shared-kernel',
              ],
            },
            { from: 'domain', allow: [['domain', { module: '${from.module}' }], 'shared-kernel'] },
            {
              from: 'application',
              allow: [
                ['domain', { module: '${from.module}' }],
                ['application', { module: '${from.module}' }],
                'contracts',
                'shared-kernel',
              ],
            },
            {
              from: 'infrastructure',
              allow: [
                ['domain', { module: '${from.module}' }],
                ['infrastructure', { module: '${from.module}' }],
                'contracts',
                'shared-kernel',
              ],
            },
            {
              from: 'interface',
              allow: [
                ['application', { module: '${from.module}' }],
                ['interface', { module: '${from.module}' }],
                'contracts',
              ],
            },
            // contracts may lean on the shared kernel (pure primitives / catalogs like
            // the git-platform registry). shared-kernel never imports contracts, so this
            // introduces no cycle.
            { from: 'contracts', allow: ['contracts', 'shared-kernel'] },
            { from: 'shared-kernel', allow: ['shared-kernel'] },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...NO_DIRECT_TIME_RANDOM,
        NO_AS_UNKNOWN_AS,
        NO_SCATTERED_DEFAULT_IMAGE,
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Port implementations are the ONLY sanctioned place for time/random (01 §3 exemption).
  // `as unknown as` stays banned even here.
  //
  // `shared-kernel/src/ports/time.util.ts` joins them for a DIFFERENT reason, spelled
  // out at `fromEpochMs`: it never reads a clock, it converts an ABSOLUTE timestamp
  // handed to us by a third party (the in-sandbox agent reports file mtimes as epoch
  // seconds). The ban exists to keep "now" behind the Clock port so tests can pin it;
  // a pure `epoch → Date` function is outside what that ban is protecting.
  {
    files: [
      'apps/api/src/platform/time/**/*.ts',
      'apps/api/src/platform/access-passcode/**/*.ts',
      'packages/shared-kernel/src/ports/time.util.ts',
    ],
    rules: { 'no-restricted-syntax': ['error', NO_AS_UNKNOWN_AS] },
  },
  // 唯一允许读 SANDBOX_DEFAULT_IMAGE 的地方 —— 它就是那个「一次」（见规则注释）。
  {
    files: ['packages/shared-kernel/src/domain/builtin-image.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...NO_DIRECT_TIME_RANDOM, NO_AS_UNKNOWN_AS],
    },
  },
  // Tests may use wall-clock time and cross layers freely — but NOT `as unknown as`.
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', '**/test/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', NO_AS_UNKNOWN_AS],
      'boundaries/element-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  // e2e 另加一条：app 装配必须走共用函数（见 NO_HANDROLLED_APP_SETUP 的注释）。
  {
    files: ['apps/api/test/e2e/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', NO_AS_UNKNOWN_AS, ...NO_HANDROLLED_APP_SETUP],
    },
  },
);
