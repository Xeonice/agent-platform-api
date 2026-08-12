import { runSandboxProviderContractTests } from '@platform/contracts/testkit';
import type { SandboxProviderContract, SandboxProviderCapabilities } from '@platform/contracts';

/**
 * Contract-testkit run (docs/backend/04 §10) — a REQUIRED CI check (09 §2.3).
 * A trivial in-memory provider must satisfy SP-01 / CAP-01. When the real
 * aio / boxlite providers land they register here against the same suite —
 * no double standard.
 */
const capabilities: SandboxProviderCapabilities = {
  spawnTty: true,
  volumeMount: true,
  updateResources: false,
  pauseResume: false,
  snapshot: false,
  watchEvents: true,
};

class FakeSandboxProvider implements SandboxProviderContract {
  readonly name = 'fake';
  readonly capabilities = capabilities;
  async create(spec: { sandboxId: string }) {
    return { provider: this.name, ref: `ref-${spec.sandboxId}` };
  }
}

runSandboxProviderContractTests('fake (in-memory)', () => new FakeSandboxProvider(), {
  expectedCapabilities: capabilities,
});
