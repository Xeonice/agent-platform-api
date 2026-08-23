import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import {
  createDockerClient,
  isDockerAvailable,
} from '../../../../packages/modules/sandbox/src/infrastructure/providers/docker/docker-client';
import { DockerContainerBackend } from '../../../../packages/modules/sandbox/src/infrastructure/providers/docker/docker-container-backend';
import type { ProcessStream, SandboxHandle } from '@platform/contracts';

/**
 * DOCKER-REQUIRED e2e (docs/backend S1 acceptance). Creates a REAL container →
 * exec `ls /` → asserts real paths → destroys. If the docker daemon is
 * unreachable it SKIPS loudly (never silently fake-passes).
 */
const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? 'alpine:3.20';
const docker = createDockerClient();
const dockerUp = await isDockerAvailable(docker).catch(() => false);

if (!dockerUp) {
  console.warn(
    '\n[33m========================================================================\n' +
      '[docker-provider.e2e] SKIPPED — docker daemon unreachable (DOCKER_HOST=' +
      (process.env.DOCKER_HOST ?? 'default socket') +
      ').\n' +
      'Run it with docker up to verify the real create→exec→destroy chain\n' +
      '(builtin-provider-contract.e2e also needs the daemon, for SP-01).\n' +
      '========================================================================[0m\n',
  );
}

function collectExec(stream: ProcessStream): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    let out = '';
    stream.onData((c) => {
      out += c.toString('utf8');
    });
    stream.onExit((code) => resolve({ out, code }));
  });
}

describe.skipIf(!dockerUp)('DockerContainerBackend — aio 本机容器后端 (real docker)', () => {
  const provider = new DockerContainerBackend(docker, {
    name: 'aio',
    isolationLabel: 'container',
    keepAliveCmd: ['tail', '-f', '/dev/null'],
    capabilities: {
      spawnTty: true,
      volumeMount: true,
      updateResources: true,
      pauseResume: true,
      snapshot: false,
      watchEvents: true,
      headlessTask: false,
    },
  });
  let handle: SandboxHandle | undefined;
  const wsDir = mkdtempSync(join(tmpdir(), 'platform-e2e-ws-'));

  afterAll(async () => {
    if (handle) await provider.destroy(handle).catch(() => undefined);
  });

  it('creates a container, execs ls, sees real paths, then destroys', async () => {
    // ensure image present
    await new Promise<void>((resolve, reject) => {
      docker.pull(IMAGE, (err: unknown, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err instanceof Error ? err : new Error(String(err)));
        docker.modem.followProgress(stream, (e: unknown) =>
          e ? reject(e instanceof Error ? e : new Error(String(e))) : resolve(),
        );
      });
    });

    handle = await provider.create({
      sandboxId: `e2e-${Date.now()}`,
      quota: { cores: 1, ramMb: 256, diskMb: 512 },
      image: { ref: IMAGE, digest: 'sha256:e2e' },
      env: {},
      volumes: [{ source: wsDir, target: '/workspace', mode: 'rw', kind: 'host-path' }],
      labels: { 'platform.test': 'true' },
    });
    expect(handle.provider).toBe('aio');

    await provider.start(handle);
    const status = await provider.inspect(handle);
    expect(status.lifecycleState).toBe('instance_running');

    const stream = await provider.spawn(handle, { cmd: ['ls', '/'], tty: false });
    const { out } = await collectExec(stream);
    expect(out).toMatch(/usr|etc/);

    await provider.destroy(handle);
    handle = undefined;
    const gone = await provider.inspect({ provider: 'aio', providerSandboxId: 'nonexistent' });
    expect(gone.lifecycleState).toBe('instance_missing');
  }, 60_000);
});
