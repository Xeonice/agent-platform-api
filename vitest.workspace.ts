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
  '@platform/automation': r('packages/modules/automation/src/index.ts'),
  '@platform/sandbox': r('packages/modules/sandbox/src/index.ts'),
  '@platform/terminal': r('packages/modules/terminal/src/index.ts'),
  '@platform/credential': r('packages/modules/credential/src/index.ts'),
  '@platform/runtime': r('packages/modules/runtime/src/index.ts'),
  '@platform/image': r('packages/modules/image/src/index.ts'),
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
const evidenceSetup = r('acceptance/support/assertion-evidence.setup.ts');

export default defineWorkspace([
  {
    ...shared,
    test: {
      name: 'pure',
      include: ['acceptance/*/pure/**/*.spec.ts'],
      environment: 'node',
      setupFiles: [evidenceSetup],
    },
  },
  {
    ...shared,
    test: {
      name: 'service',
      setupFiles: [evidenceSetup],
      include: ['acceptance/*/service/**/*.spec.ts'],
      environment: 'node',
      testTimeout: 15000,
    },
  },
  {
    ...shared,
    test: {
      name: 'sqlite',
      include: ['acceptance/*/sqlite/**/*.spec.ts'],
      environment: 'node',
      setupFiles: [evidenceSetup],
    },
  },
  {
    ...shared,
    test: {
      name: 'protocol',
      include: ['acceptance/*/protocol/**/*.spec.ts'],
      environment: 'node',
      setupFiles: [r('acceptance/support/protocol.setup.ts'), evidenceSetup],
      hookTimeout: 30000,
      testTimeout: 30000,
    },
  },
]);
