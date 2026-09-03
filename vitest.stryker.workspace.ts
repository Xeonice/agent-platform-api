// Stryker 专用 workspace（29 §3.3）。
//
// ⚠️ 为什么需要这个文件：`vitest.workspace.ts` 会被 vitest **自动发现并接管 include**，
// 即使 `--config` 指定了别的 config、即使设了 `root` —— 实测跑出来是全仓 1733 条而不是
// 目标模块的 111 条，Stryker 还会把 e2e 拉进 initial run 然后失败。
// `test.workspace` 显式指向本文件，才能切断那次自动发现。
//
// 本文件只含 unit + integration，**刻意不含 e2e**：每个变异体重跑一遍 e2e 不现实（29 §3.3.3）。
import { defineWorkspace } from 'vitest/config';
import { resolve } from 'node:path';
import swc from 'unplugin-swc';

const r = (p: string) => resolve(__dirname, p);
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

// STRYKER_SCOPE=packages/modules/automation 只跑该模块的测试；不设则跑全仓 unit+integration。
const scope = process.env['STRYKER_SCOPE'] ?? 'packages';

export default defineWorkspace([
  {
    plugins: [swc.vite({ module: { type: 'es6' } })],
    resolve: { alias },
    test: {
      name: 'stryker',
      environment: 'node',
      include:
        scope === 'packages'
          ? [
              'packages/**/test/{domain,unit,application}/**/*.spec.ts',
              // apps/api 的 bootstrap 层也有纯单测（全局 pipe/filter），它们不属于任何
              // module package 但同样密封可测 —— 漏了它们 `apps/api/src` 的变异体会全是
              // NoCoverage，基线就会假性偏低。
              'apps/api/test/unit/**/*.spec.ts',
            ]
          : [`${scope}/**/test/{domain,unit,application,integration}/**/*.spec.ts`],
    },
  },
]);
