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

export default defineWorkspace([
  {
    ...shared,
    test: {
      name: 'unit',
      include: [
        'packages/**/test/domain/**/*.spec.ts',
        'packages/**/test/unit/**/*.spec.ts',
        'packages/**/test/application/**/*.spec.ts',
        // apps/api 的 bootstrap 层（全局 pipe/filter）也有纯单测:它们不属于任何
        // module package,但同样是密封可测的。此前这条不在 include 里,
        // `apps/api/test/**` 只被 e2e 那条(`*.e2e-spec.ts`)覆盖 ⇒ 写在这里的
        // `*.spec.ts` 会被**静默跳过**,连"没有测试文件"都不报。
        'apps/api/test/unit/**/*.spec.ts',
      ],
      environment: 'node',
    },
  },
  {
    ...shared,
    test: {
      name: 'integration',
      include: [
        'packages/**/test/integration/**/*.spec.ts',
        // 平台级设施（audit_events 这类不属于任何限界上下文的表）住在 apps/api,
        // 它们的 drizzle 往返同样要在真 sqlite 上测。⚠️ 少了这一条,写在
        // `apps/api/test/integration/` 里的 spec 会被**静默跳过** —— 与上面 unit
        // 那条注释记的是同一个坑,只是换了一个目录。
        'apps/api/test/integration/**/*.spec.ts',
      ],
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
      // Every e2e file gets a throwaway DATA_ROOT before it can import AppModule.
      // See the long note in the setup file: `LoggingModule` is global and its writer
      // opens a real file in the DI constructor, so WITHOUT this any spec that boots
      // AppModule writes into the repo's `api/data/` — the dev server's own data root.
      setupFiles: [r('apps/api/test/e2e/_data-root.setup.ts')],
      hookTimeout: 30_000,
      testTimeout: 30_000,
      // e2e drive SHARED external resources (docker daemon, the :5001 registry,
      // and — critically — BoxLite, which permits only ONE runtime per BOXLITE_HOME
      // (~/.boxlite) AT A TIME across processes. Multiple runtimes coexist fine
      // within one process, so ALL e2e files must run in a SINGLE worker process
      // sequentially; separate forks would contend on the BoxLite lock and 500.
      // Unit/integration/contract projects stay parallel.
      //
      // ⚠️⚠️ 下面这行是**死的** —— 它表达意图，但不产生效果（2026-09-14 实测）。
      // `createForksPool` 读的是 `ctx.config.poolOptions?.forks`，而 workspace 模式下
      // pool 在**根级**创建一次，project 级的 poolOptions 根本不参与。实测 e2e 一直是
      // 9 个 worker 并行跑的,从来没有串行过。之所以没炸:碰 BoxLite 的那 7 个 e2e 在
      // 没有本机镜像的机器上全部被 skip —— 问题被 skip 掩盖着,镜像一铺好就会撞锁。
      // ⛔ 不要因为"配了就该生效"而信任它。真正的串行保证在 `scripts/vitest-capped.mjs`
      // (VITEST_MAX_FORKS=1),那是唯一能在 pool 创建前把值送进去的位置。
      // 这一行保留:语义正确,且将来 vitest 若修了 project 级 pool 配置它会自动接上。
      poolOptions: { forks: { singleFork: true } },
    },
  },
]);
