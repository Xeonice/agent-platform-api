// Stryker 配置（docs/shared/29 §3.3）。
//
// 跑法：
//   pnpm test:mutation                                   # 全仓基线
//   STRYKER_SCOPE=packages/modules/automation pnpm test:mutation   # 单模块
//
// ⚠️ `mutate` 与 `vitest.stryker.workspace.ts` 的 include 必须同源于 STRYKER_SCOPE，
// 否则会出现「变异了某个模块、却没跑它的测试」⇒ 整片 NoCoverage 的假象。
const scope = process.env.STRYKER_SCOPE ?? 'packages';
const isFullRepo = scope === 'packages';

export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.stryker.config.ts' },
  mutate: [
    `${scope}/**/src/**/*.ts`,
    ...(isFullRepo ? ['apps/api/src/**/*.ts'] : []),
    // 装配与出口文件没有行为，变异它们只产出噪音
    `!${scope}/**/src/**/*.module.ts`,
    `!${scope}/**/src/index.ts`,
    '!apps/api/src/**/*.module.ts',
    '!apps/api/src/main.ts',
    // 生成物/迁移不是手写代码
    '!**/drizzle/**',
  ],
  coverageAnalysis: 'perTest',
  // ⚠️ **必须开**（29 §3.3.2b 实测）：静态变异体（模块加载期执行的代码 —— 顶层常量、
  // 类字段初始化）无法被 perTest 优化，每个都要重跑整套测试。全仓实测有 1863 个
  // （占 9%），Stryker 自己估算它们要吃掉 **86% 的总时间** ⇒ 约 15 小时。
  // 关掉它们，剩下 17806 个按正常速率跑完只要 20 分钟出头。
  // 代价：这 9% 的变异体标记为 Ignored，基线里它们是未知量 —— 读数时要带上这个前提。
  ignoreStatic: true,
  reporters: ['json', 'clear-text'],
  jsonReporter: { fileName: `reports/mutation/${isFullRepo ? 'full' : 'scoped'}.json` },
  htmlReporter: { fileName: `reports/mutation/${isFullRepo ? 'full' : 'scoped'}.html` },
  timeoutMS: 20000,
  concurrency: 4,
};
