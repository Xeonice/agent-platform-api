#!/usr/bin/env node
/**
 * 给 vitest 套一个并行度上限，然后把参数原样转交。
 *
 * ── 为什么需要这一层 ────────────────────────────────────────────────
 *
 * ① vitest 的默认并行度是 `逻辑核数 − 1`，只看 CPU、不看内存。每个 fork 是独立
 *    node 进程，各自扛一整套 SWC 转译后的模块图。本机（10 核）实测：光 unit 一个
 *    project 就拉起 9 个 worker、峰值 1.6 GB。
 *
 * ② 内存贴顶的机器上这一下足以越线，而 OOM killer 挑的往往不是测试自己、是旁边
 *    的后台进程。本机实测被杀的是正在跑的 dev server —— 测试本身若无其事地全绿，
 *    所以这个因果关系很难被看见，只表现为"服务莫名其妙又没了"。
 *
 * ③ ⚠️⚠️ 这个上限**只能从进程外面给**，写进 `vitest.workspace.ts` 是死的。
 *    `createForksPool` 读的是 `ctx.config.poolOptions?.forks`，而 workspace 模式下
 *    pool 在**根级**创建一次 —— project 级的 `poolOptions`、顶层 `maxWorkers`
 *    统统不参与。写在 project 里不报错、测试全绿、worker 数一个不少（实测与不设时
 *    逐项相同：9 个 worker / 1.6 GB），**没有任何信号告诉你那行配置是死的**。
 *    在 workspace 文件顶部设 `process.env` 同样太晚 —— `resolveConfig` 早读过了。
 *    只有在 vitest 进程**启动之前**把环境变量备好才算数，于是有了这个壳。
 *
 * ⛔ 不按环境分支（本地一套、CI 一套）：CI runner 的内存只会比开发机更紧，两边同
 * 一个上限，本地复现的就是 CI 会遇到的。
 *
 * ── e2e 为什么必须是 1 ──────────────────────────────────────────────
 *
 * e2e 驱动的是**共享的外部资源**：docker daemon、:5001 registry，以及——最要命的
 * ——BoxLite：每个 BOXLITE_HOME(~/.boxlite) 同一时刻只允许 ONE runtime 跨进程存在。
 * 同一进程内多个 runtime 相安无事，分开 fork 就会争锁然后 500。
 *
 * ⚠️ `vitest.workspace.ts` 里 e2e 那条 `poolOptions.forks.singleFork` 正是为此而
 * 写的，但按上面 ③ 的同一个原因，**它从来没有生效过**：实测 e2e 是 9 个 worker
 * 并行跑的。之所以一直没炸，是因为碰 BoxLite 的那 7 个 e2e 在没有本机镜像的机器上
 * 全部被 skip —— 问题被 skip 掩盖着，镜像一铺好就会撞。串行保证现在落在这里。
 */
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

// min(4, 核数/2)：2 核的小 runner 自动降到 1，不会反过来抢 CPU。
const CAP = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));

const args = process.argv.slice(2);
const named = args.reduce(
  (acc, a, i) => (a === '--project' && args[i + 1] ? [...acc, args[i + 1]] : acc),
  [],
);

/**
 * 跑一趟 vitest。min/max 必须成对给 —— 只给 max 时默认 min 会比它大，vitest 直接
 * `RangeError: options.minThreads and options.maxThreads must not conflict`。
 * 已有的外部设置优先，方便临时调参：`VITEST_MAX_FORKS=1 pnpm test:unit`。
 */
function run(argv, cap) {
  return new Promise((resolve) => {
    const child = spawn('vitest', argv, {
      stdio: 'inherit',
      env: {
        ...process.env,
        VITEST_MIN_FORKS: process.env.VITEST_MIN_FORKS ?? '1',
        VITEST_MAX_FORKS: process.env.VITEST_MAX_FORKS ?? String(cap),
      },
    });
    child.on('exit', (code, signal) => {
      // 被信号杀掉时 code 是 null。⛔ 直接 exit(null) 会变成 0 —— 那会把一次
      // "测试进程被 OOM killer 干掉" 报告成通过，正是本文件要防的那种事。
      if (signal !== null) {
        console.error(`\n✖ vitest 被信号 ${signal} 终止（内存不足时 OOM killer 送的是 SIGKILL）`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

const isE2E = named.includes('e2e');
const isAll = named.length === 0;

let code;
if (isE2E) {
  code = await run(args, 1);
} else if (isAll) {
  // 全量：并行的三个先跑，e2e 单独一趟串行。⚠️ 不能在一趟里分别设 —— pool 是根级
  // 共享的，一个进程只有一个并行度。分两趟是为了让 e2e 拿到它必须的 1。
  const rest = args.filter((a) => a !== 'run');
  code = await run(
    ['run', '--project', 'unit', '--project', 'integration', '--project', 'contract', ...rest],
    CAP,
  );
  if (code === 0) code = await run(['run', '--project', 'e2e', ...rest], 1);
} else {
  code = await run(args, CAP);
}
process.exit(code);
