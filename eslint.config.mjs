import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

/**
 * Flat ESLint config. Two harness pillars enforced here (docs/backend/01 §3, shared/09 §2.2):
 *   1. eslint-plugin-boundaries — DDD four-layer dependency rules (error level).
 *   2. no-restricted-syntax — bans new Date() / Date.now() / crypto.randomUUID(),
 *      forcing everything through the Clock / IdGenerator ports (25 §1.4).
 * Both are `error` and CI runs with --max-warnings=0, so violations cannot merge.
 */
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
            'packages/modules/sandbox/tsconfig.json',
            'apps/api/tsconfig.json',
          ],
        },
        node: true,
      },
      // The composition-root module file is matched FIRST (order matters) so it is
      // NOT treated as `interface` — it is the one place a port is wired to its impl.
      'boundaries/elements': [
        {
          type: 'module-root',
          mode: 'file',
          pattern: 'packages/modules/*/src/interface/*.module.ts',
        },
        { type: 'domain', pattern: 'packages/modules/*/src/domain/**' },
        { type: 'application', pattern: 'packages/modules/*/src/application/**' },
        { type: 'infrastructure', pattern: 'packages/modules/*/src/infrastructure/**' },
        { type: 'interface', pattern: 'packages/modules/*/src/interface/**' },
        { type: 'shared-kernel', pattern: 'packages/shared-kernel/**' },
        { type: 'contracts', pattern: 'packages/contracts/**' },
      ],
      'boundaries/ignore': ['**/*.spec.ts', '**/*.e2e-spec.ts', '**/test/**'],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            {
              from: 'module-root',
              allow: [
                'domain',
                'application',
                'infrastructure',
                'interface',
                'contracts',
                'shared-kernel',
              ],
            },
            { from: 'domain', allow: ['domain', 'shared-kernel'] },
            { from: 'application', allow: ['domain', 'contracts', 'application', 'shared-kernel'] },
            {
              from: 'infrastructure',
              allow: ['domain', 'contracts', 'infrastructure', 'shared-kernel'],
            },
            { from: 'interface', allow: ['application', 'interface', 'contracts'] },
            { from: 'contracts', allow: ['contracts'] },
            { from: 'shared-kernel', allow: ['shared-kernel'] },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
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
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Port implementations are the ONLY sanctioned place for time/random (01 §3 exemption).
  {
    files: ['apps/api/src/platform/time/**/*.ts', 'apps/api/src/platform/access-passcode/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  // Tests may use wall-clock time and cross layers freely.
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', '**/test/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      'boundaries/element-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
