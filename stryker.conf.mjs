// Stryker 配置（docs/shared/29 §3.3）。
//
// 跑法：
//   pnpm test:mutation                                   # 全仓基线 → reports/mutation/full.json
//   STRYKER_SCOPE=packages/modules/automation pnpm test:mutation   # 单模块 → …/packages-modules-automation.json
//   STRYKER_MUTATE_FILES="a.ts\nb.ts" pnpm test:mutation           # 只变异这几个文件（PR 增量，见 §3.3.4）
//
// ⚠️ `mutate` 与 `vitest.stryker.workspace.ts` 的 include 必须同源于 STRYKER_SCOPE，
// 否则会出现「变异了某个模块、却没跑它的测试」⇒ 整片 NoCoverage 的假象。
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';

const scope = process.env.STRYKER_SCOPE ?? 'packages';
const isFullRepo = scope === 'packages';

// PR 增量：由 CI 用 `git diff` 算出改动的 src 文件后塞进来（换行或逗号分隔）。
// ⚠️ 走 env 而不是 CLI 的 `--mutate`，因为 CLI 传 `--mutate` 会**整体替换**下面那份
// 数组 —— 连 `!**/*.module.ts` 这些排除项一起丢掉，于是增量跑反而会变异装配文件。
const changedFiles = (process.env.STRYKER_MUTATE_FILES ?? '')
  .split(/[\n,]+/)
  .map((f) => f.trim())
  .filter(Boolean);
const isChangedOnly = changedFiles.length > 0;

// 装配与出口文件没有行为，变异它们只产出噪音；生成物/迁移不是手写代码。
// 三种模式共用同一份排除项 —— 增量跑与全量跑必须是同一把尺子。
const excludes = [
  `!${scope}/**/src/**/*.module.ts`,
  `!${scope}/**/src/index.ts`,
  '!apps/api/src/**/*.module.ts',
  '!apps/api/src/main.ts',
  '!**/drizzle/**',
];

// ⚠️ 报告名必须能一眼看出「这是哪一次跑的」（29 §3.3.4）。
// 曾经所有 scoped 跑法共用 `reports/mutation/scoped.json`：跑完 sandbox 再跑 automation，
// 读到的可能是上一轮的 sandbox 报告；**跑失败时更糟 —— Stryker 不写报告，旧文件原地不动，
// 于是「失败」看起来像「成功且分数没变」**。已实际骗过人一次。
// 现在：① 文件名带 scope（或改动文件集的指纹）；② 跑之前先删掉本次的目标文件。
// 两条合起来让「读到别人的报告」和「读到上一轮的报告」在文件系统层面都不可能。
const label = isChangedOnly
  ? `changed-${createHash('sha1')
      .update([...changedFiles].sort().join('\n'))
      .digest('hex')
      .slice(0, 8)}`
  : isFullRepo
    ? 'full'
    : scope.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
const jsonFile = `reports/mutation/${label}.json`;
const htmlFile = `reports/mutation/${label}.html`;
rmSync(jsonFile, { force: true });
rmSync(htmlFile, { force: true });

export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  // ⚠️ `vitest.related` 保持默认 **true**，这是实测撞出来的取舍（29 §3.3.4）：
  //   - 关掉它，每个变异体都要重跑全仓 1275 条 —— 单文件 63 个变异体跑了 5 分钟还没完，
  //     比全量基线的 ~10 个/秒 慢了约 40 倍。增量跑比全量跑还慢，那就没有意义了。
  //   - 开着它，vitest 只跑「import 到被变异文件」的测试文件，增量跑才是分钟级。
  // 代价：改动的文件**在 unit 层一条相关测试都没有**时（例如只由 e2e 覆盖的 controller /
  // bootstrap service），相关测试集为空 ⇒ Stryker 报 `No tests were executed` 并 exit 1。
  // 那不是「跑挂了」，是「这些文件 unit 层没人管」。CI 的增量 job 认这条日志并翻译成人话，
  // 不让它变成一个吓人的红叉 —— 见 .github/workflows/mutation.yml。
  vitest: { configFile: 'vitest.stryker.config.ts' },
  mutate: isChangedOnly
    ? [...changedFiles, ...excludes]
    : [`${scope}/**/src/**/*.ts`, ...(isFullRepo ? ['apps/api/src/**/*.ts'] : []), ...excludes],
  coverageAnalysis: 'perTest',
  // ⚠️ **必须开**（29 §3.3.2b 实测）：静态变异体（模块加载期执行的代码 —— 顶层常量、
  // 类字段初始化）无法被 perTest 优化，每个都要重跑整套测试。全仓实测有 1863 个
  // （占 9%），Stryker 自己估算它们要吃掉 **86% 的总时间** ⇒ 约 15 小时。
  // 关掉它们，剩下 17806 个按正常速率跑完只要 20 分钟出头。
  // 代价：这 9% 的变异体标记为 Ignored，基线里它们是未知量 —— 读数时要带上这个前提。
  ignoreStatic: true,
  reporters: ['json', 'clear-text'],
  jsonReporter: { fileName: jsonFile },
  htmlReporter: { fileName: htmlFile },
  // ⛔ `break: null` = **不设分数门禁**，这是刻意的（29 §3.3.3 第 1 条）：等价变异体让
  // 100% 永不可达，任何绝对阈值都只会逼人写无意义的测试去凑分数。high/low 只影响
  // clear-text 报告的着色，不影响退出码。CI 两条路径都靠这一行保持「只报数、不拦人」。
  thresholds: { high: 80, low: 60, break: null },
  timeoutMS: 20000,
  // 4 是本机（多核）的实测值，也是所有已记录耗时的前提。CI runner 核数更少时把它调下来
  // —— 并发超过核数会互相抢 CPU，反而更慢。
  concurrency: Number(process.env.STRYKER_CONCURRENCY ?? 4),
};
