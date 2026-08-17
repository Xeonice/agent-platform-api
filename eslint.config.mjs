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
            { from: 'contracts', allow: ['contracts'] },
            { from: 'shared-kernel', allow: ['shared-kernel'] },
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...NO_DIRECT_TIME_RANDOM, NO_AS_UNKNOWN_AS],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Port implementations are the ONLY sanctioned place for time/random (01 §3 exemption).
  // `as unknown as` stays banned even here.
  {
    files: ['apps/api/src/platform/time/**/*.ts', 'apps/api/src/platform/access-passcode/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', NO_AS_UNKNOWN_AS] },
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
);
