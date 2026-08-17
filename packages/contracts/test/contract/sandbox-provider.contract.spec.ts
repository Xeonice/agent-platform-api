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
  watchEvents: true,
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
