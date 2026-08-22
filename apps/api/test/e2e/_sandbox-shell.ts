import type { INestApplication } from '@nestjs/common';
import { asSandboxId } from '@platform/shared-kernel';
import { SANDBOX_PROVIDER_REGISTRY } from '@platform/contracts';
import type { ProcessStream, ProviderRegistry } from '@platform/contracts';
import { SANDBOX_REPOSITORY } from '../../../../packages/modules/sandbox/src/domain/repositories/sandbox.repository';
import type { SandboxRepository } from '../../../../packages/modules/sandbox/src/domain/repositories/sandbox.repository';

/**
 * Run a shell script inside a live sandbox over the ONE-SHOT EXEC data plane.
 *
 * WHY THE e2e STOPPED TYPING INTO THE TERMINAL FOR THIS (S5): the terminal is no
 * longer a bare shell — the gateway attaches the tmux session provision started, and
 * that session is running the AGENT CLI, usually a full-screen TUI that owns the
 * keyboard (裁决 D-15 / 26 §8). Driving `ls /` through it would be testing the agent's
 * input handling, not the platform's. The exec path goes through the very same
 * in-sandbox agent and the very same bind mount, so nothing about the assertion's
 * INTENT is weakened — only the keyboard is no longer ours to borrow.
 */
export async function sandboxShell(
  app: INestApplication,
  sandboxId: string,
): Promise<(script: string) => Promise<string>> {
  const repo = app.get<SandboxRepository>(SANDBOX_REPOSITORY, { strict: false });
  const sandbox = await repo.findById(asSandboxId(sandboxId));
  if (!sandbox?.providerSandboxId) throw new Error(`sandbox ${sandboxId} has no live instance`);
  const provider = app
    .get<ProviderRegistry>(SANDBOX_PROVIDER_REGISTRY, { strict: false })
    .get(sandbox.provider);
  const handle = {
    provider: sandbox.provider,
    providerSandboxId: sandbox.providerSandboxId,
    agentEndpointPort: sandbox.agentEndpointPort ?? undefined,
    agentAuthToken: sandbox.agentAuthToken ?? undefined,
  };
  return async (script: string) =>
    collect(await provider.spawn(handle, { cmd: ['sh', '-c', script], tty: false }));
}

/** Collect a one-shot exec stream's output to EOF. */
function collect(stream: ProcessStream): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    stream.onData((c) => {
      out += c.toString('utf8');
    });
    stream.onExit(() => resolve(out));
  });
}
