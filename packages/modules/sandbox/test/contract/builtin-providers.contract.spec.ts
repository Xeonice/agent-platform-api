import { runSandboxProviderContractTests } from '@platform/contracts/testkit';
import { createDockerClient } from '../../src/infrastructure/providers/docker/docker-client';
import { AioSandboxProvider } from '../../src/infrastructure/providers/aio/aio-sandbox.provider';
import { BoxliteSandboxProvider } from '../../src/infrastructure/providers/boxlite/boxlite-sandbox.provider';

/**
 * "内建实现在 CI 跑同一套 testkit——无双重标准" (docs/backend/04 §10), made real:
 * the REAL `aio` and `boxlite` classes run the SAME `runSandboxProviderContractTests`
 * the fake and any third-party provider run.
 *
 * This file carries the HOST-FREE half (SP-00 / CAP-01): constructing either provider
 * touches neither the docker daemon nor the BoxLite hypervisor, so these clauses run
 * unconditionally in `pnpm test:contract` — no skip, no excuse.
 *
 * The live half (SP-01, which must really create a sandbox) runs in
 * `apps/api/test/e2e/builtin-provider-contract.e2e-spec.ts`: it needs a reachable
 * host, and BoxLite additionally permits only ONE runtime per BOXLITE_HOME across
 * processes — the `e2e` vitest project is the single-fork project that respects that
 * lock, while `contract` runs in parallel forks.
 */
runSandboxProviderContractTests(
  'aio (built-in, REAL implementation)',
  () => new AioSandboxProvider(createDockerClient()),
  {
    // the declared bits, pinned verbatim (04 §2.1/§2.5)
    expectedCapabilities: {
      spawnTty: true,
      volumeMount: true,
      // ⚠️ 三位 2026-08-29 从 `true` 改成 `false`：它们是谎报，而**这份 pin 一直在
      // 帮着钉住谎报**——`expectedCapabilities` 只保证「值没变过」，不保证「值是真的」。
      // 真话由 CAP-03 保证（位 ⟺ 方法在不在），本 pin 退回它本来的角色：回归守卫。
      updateResources: false,
      pauseResume: false,
      snapshot: false,
      watchEvents: false,
      headlessTask: true,
    },
    skipLiveReason: 'live clauses run in apps/api/test/e2e/builtin-provider-contract.e2e-spec.ts',
  },
);

runSandboxProviderContractTests(
  'boxlite (built-in, REAL implementation)',
  () => new BoxliteSandboxProvider(),
  {
    expectedCapabilities: {
      spawnTty: true,
      volumeMount: true,
      updateResources: false,
      pauseResume: false,
      snapshot: false,
      // ⚠️ 同 aio：从来没有 `watchEvents()` 方法。两个 provider 同时错了这么久，
      // 是因为 CAP-03 之前没有任何东西要求任何一位兑现。
      watchEvents: false,
      headlessTask: true,
    },
    skipLiveReason: 'live clauses run in apps/api/test/e2e/builtin-provider-contract.e2e-spec.ts',
  },
);
