import { resolve } from 'node:path';
import { defineWorkspace } from 'vitest/config';
import swc from 'unplugin-swc';

const r = (p: string) => resolve(__dirname, p);

/**
 * Resolve internal packages to SOURCE so tests run without a prior build
 * (CI runs tests before `build`, shared/09 §2.3).
 */
const alias = {
  '@platform/shared-kernel': r('packages/shared-kernel/src/index.ts'),
  '@platform/contracts/testkit': r('packages/contracts/src/testkit/index.ts'),
  '@platform/contracts': r('packages/contracts/src/index.ts'),
  '@platform/project': r('packages/modules/project/src/index.ts'),
  '@platform/sandbox': r('packages/modules/sandbox/src/index.ts'),
  '@platform/terminal': r('packages/modules/terminal/src/index.ts'),
};

// SWC transform gives NestJS the decorator metadata Vitest/esbuild would drop.
const plugins = [
  swc.vite({
    jsc: {
      parser: { syntax: 'typescript', decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
    },
  }),
];

const shared = { resolve: { alias }, plugins };

export default defineWorkspace([
  {
    ...shared,
    test: {
      name: 'unit',
      include: [
        'packages/**/test/domain/**/*.spec.ts',
        'packages/**/test/unit/**/*.spec.ts',
        'packages/**/test/application/**/*.spec.ts',
      ],
      environment: 'node',
    },
  },
  {
    ...shared,
    test: {
      name: 'integration',
      include: ['packages/**/test/integration/**/*.spec.ts'],
      environment: 'node',
    },
  },
  {
    ...shared,
    test: {
      name: 'contract',
      include: ['packages/**/test/contract/**/*.spec.ts'],
      environment: 'node',
    },
  },
  {
    ...shared,
    test: {
      name: 'e2e',
      include: ['apps/api/test/**/*.e2e-spec.ts'],
      environment: 'node',
      hookTimeout: 30_000,
      testTimeout: 30_000,
      // e2e drive SHARED external resources (docker daemon, the :5001 registry,
      // and — critically — BoxLite, which permits only ONE runtime per BOXLITE_HOME
      // (~/.boxlite) AT A TIME across processes. Multiple runtimes coexist fine
      // within one process, so run ALL e2e files in a SINGLE worker process
      // sequentially; separate forks would contend on the BoxLite lock and 500.
      // Unit/integration/contract projects stay parallel.
      poolOptions: { forks: { singleFork: true } },
    },
  },
]);
