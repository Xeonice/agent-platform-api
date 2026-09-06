import { runSandboxProviderContractTests } from '@platform/contracts/testkit';
import type {
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderContext,
  SandboxHandle,
  SandboxRuntimeStatus,
  ProcessSpec,
  ProcessStream,
} from '@platform/contracts';

/**
 * Contract-testkit run (docs/backend/04 §10) — a REQUIRED CI check (09 §2.3).
 * A trivial in-memory provider must satisfy SP-01 / CAP-01. The real aio/boxlite
 * providers are docker-backed and are exercised in the docker-required e2e (which
 * skips when the daemon is unreachable), never here.
 */
const capabilities: SandboxProviderCapabilities = {
  spawnTty: true,
  volumeMount: true,
  updateResources: false,
  pauseResume: false,
  snapshot: false,
  // ⚠️ `false`：这个 fake 没有 `watchEvents()` 方法。⚠️ **它以前写的是 `true`**，
  // 而 CAP-03 一落地就把它抓了出来——连契约包自己的样板 provider 都在谎报，
  // 说明问题从来不是「某个实现写错了」，而是**没有条款要求兑现**。
  watchEvents: false,
  headlessTask: false,
};

class FakeSandboxProvider implements SandboxProvider {
  readonly name = 'fake';
  readonly capabilities = capabilities;
  async create(ctx: SandboxProviderContext): Promise<SandboxHandle> {
    return { provider: this.name, providerSandboxId: `box-${ctx.sandboxId}` };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
  async inspect(): Promise<SandboxRuntimeStatus> {
    return { lifecycleState: 'instance_running' };
  }
  async spawn(_h: SandboxHandle, _s: ProcessSpec): Promise<ProcessStream> {
    return {
      ref: 'ref-1',
      onData() {},
      write() {},
      resize() {},
      onExit() {},
      // ⚠️ `detach` 是契约必需的 —— 这个替身一直缺着，而测试代码此前没被 typecheck
      //    看过（2026-09-05 补）。⛔ 这正是「替身扮演不全，契约改了它也不红」的形态。
      detach() {},
      async kill() {},
    };
  }
}

const context: SandboxProviderContext = {
  sandboxId: 'sbx-testkit-1',
  quota: { cores: 1, ramMb: 512, diskMb: 1024 },
  image: { ref: 'example/image:latest', digest: 'sha256:deadbeef' },
  env: {},
  volumes: [],
  labels: { 'platform.managed': 'true' },
};

runSandboxProviderContractTests('fake (in-memory)', () => new FakeSandboxProvider(), {
  expectedCapabilities: capabilities,
  context,
});
