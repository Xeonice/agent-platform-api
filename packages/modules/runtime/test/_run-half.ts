import type { RuntimeAdapter, RuntimeInstallPlan, SandboxCommand } from '@platform/contracts';

/**
 * `RuntimeAdapter` 的**运行半边**（`getInstallPlan` / `isInstalled` / `install` /
 * `buildStartCommand` / `buildAttachCommand`）—— 只关心鉴权半边的替身把这一份摊进去。
 *
 * ── 它修的是什么：六个替身各自少了同样 5 个方法（2026-09-05）─────────────────
 * 这些测试一直是绿的，因为**测试代码从来没被 typecheck 看过**（各包 tsconfig 都是
 * `include: ["src/**\/*.ts"]`）。少的那 5 个方法在它们各自的用例里确实不会被调用，
 * 于是运行期不报错、类型期没人看 —— 缺口就这么存在了。
 *
 * ⛔ **这正是「替身扮演不全」那条危险的实物**：本仓多处注释写着「契约变了这里要跟着红，
 * 这正是 double 的价值」。而一个少了 5 个方法的 double **契约变了它也不会红** ——
 * 它连今天的契约都没满足。
 *
 * ⚠️ **方法体一律抛，不返回假值**：这几个方法在这些用例里本就不该被调用；真被调到了，
 * 要的是一条响亮的失败（"这条路径不该走到这里"），而不是一个悄悄生效的空返回。
 */
export const runHalfStub = {
  getInstallPlan(): RuntimeInstallPlan {
    throw new Error('run-half not exercised by this test');
  },
  isInstalled(): Promise<boolean> {
    return Promise.reject(new Error('run-half not exercised by this test'));
  },
  install(): Promise<void> {
    return Promise.reject(new Error('run-half not exercised by this test'));
  },
  buildStartCommand(): SandboxCommand {
    throw new Error('run-half not exercised by this test');
  },
  buildAttachCommand(): SandboxCommand {
    throw new Error('run-half not exercised by this test');
  },
} satisfies Pick<
  RuntimeAdapter,
  'getInstallPlan' | 'isInstalled' | 'install' | 'buildStartCommand' | 'buildAttachCommand'
>;
