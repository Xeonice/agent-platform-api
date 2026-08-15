import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterAll, describe, it, expect } from 'vitest';
import type { ProcessStream, SandboxHandle, SandboxProviderContext } from '@platform/contracts';
import { BoxliteSandboxProvider } from '../../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-sandbox.provider';

/**
 * BOXLITE-REQUIRED provider-level e2e (决策 B) pinning the parity gaps the
 * coordinator called out — driving `BoxliteSandboxProvider` directly so handles
 * are controllable:
 *   (A) restart-reconnect: a FRESH provider instance (empty in-process state) +
 *       a handle rebuilt from the PERSISTED `agentEndpointPort` still reaches the
 *       running detached Box — i.e. terminal/exec survive a backend restart. Plus
 *       a negative control: without the persisted port the reconnect fails LOUD.
 *   (B) stop→restart: rootfs files survive `stop()`→`start()` and the SAME
 *       forwarded port serves again (03 §4 stopped→starting reuse).
 *
 * Skips LOUDLY when the BoxLite native binary or the local `:5001` registry image
 * is missing (never fake-passes). Sweeps any leaked detached boxes in afterAll.
 */
const REGISTRY = process.env.SANDBOX_BOXLITE_REGISTRY ?? 'localhost:5001';
const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? `${REGISTRY}/agent-infra/sandbox:latest`;
const SANDBOX_PKG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/modules/sandbox/package.json',
);
const requireFromSandbox = createRequire(SANDBOX_PKG);

function boxliteBinaryPresent(): boolean {
  try {
    requireFromSandbox('@boxlite-ai/boxlite');
    return true;
  } catch {
    return false;
  }
}

async function registryServingImage(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`http://${REGISTRY}/v2/agent-infra/sandbox/tags/list`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return false;
    const body = (await res.json()) as { tags?: string[] };
    return Array.isArray(body.tags) && body.tags.includes('latest');
  } catch {
    return false;
  }
}

const boxliteReady = boxliteBinaryPresent();
const registryReady = await registryServingImage();
const ready = boxliteReady && registryReady;

if (!ready) {
  console.warn(
    '\n[33m========================================================================\n' +
      '[boxlite-provider.e2e] SKIPPED — BoxLite micro-VM prerequisites missing:\n' +
      `  - BoxLite native binary present: ${boxliteReady}\n` +
      `  - local registry ${REGISTRY} serving agent-infra/sandbox:latest: ${registryReady}\n` +
      'Pins stop→restart persistence + restart-reconnect. NOT fake-passed.\n' +
      '========================================================================[0m\n',
  );
}

const createdBoxIds = new Set<string>();

function ctxFor(sandboxId: string): SandboxProviderContext {
  return {
    sandboxId,
    quota: { cores: 2, ramMb: 2048, diskMb: 4096 },
    image: { ref: IMAGE, digest: 'sha256:boxlite-provider-e2e' },
    env: {},
    volumes: [],
    labels: {},
  };
}

function collect(stream: ProcessStream): Promise<{ out: string; code: number | null }> {
  return new Promise((res) => {
    let out = '';
    stream.onData((c) => {
      out += c.toString('utf8');
    });
    stream.onExit((code) => res({ out, code }));
  });
}

afterAll(async () => {
  for (const id of createdBoxIds) {
    await new BoxliteSandboxProvider()
      .destroy({ provider: 'boxlite', providerSandboxId: id })
      .catch(() => undefined);
  }
});

describe.skipIf(!ready)(
  'BoxliteSandboxProvider — restart reconnect + stop/restart (决策 B)',
  () => {
    it('survives a fresh provider (persisted port) and preserves rootfs across stop→restart', async () => {
      const p1 = new BoxliteSandboxProvider();
      const sandboxId = `blprov-${Date.now()}`;
      const handle = await p1.create(ctxFor(sandboxId));
      createdBoxIds.add(handle.providerSandboxId);
      await p1.start(handle);

      // create() surfaced the forwarded port so the platform can persist it.
      expect(typeof handle.agentEndpointPort).toBe('number');

      // baseline: exec over the in-sandbox agent works.
      const s1 = await p1.spawn(handle, { tty: false, cmd: ['sh', '-c', 'echo HELLO_AGENT'] });
      expect((await collect(s1)).out).toContain('HELLO_AGENT');

      // (A) restart-reconnect: a brand-new provider instance (empty Map/runtime),
      // handed a handle rebuilt ONLY from persisted fields, still reaches the box.
      const persisted: SandboxHandle = {
        provider: 'boxlite',
        providerSandboxId: handle.providerSandboxId,
        agentEndpointPort: handle.agentEndpointPort,
      };
      const p2 = new BoxliteSandboxProvider();
      const s2 = await p2.spawn(persisted, { tty: false, cmd: ['sh', '-c', 'echo RECONNECT_OK'] });
      expect((await collect(s2)).out).toContain('RECONNECT_OK');

      // (A-neg) without the persisted port, a restarted backend cannot fabricate it
      // (BoxLite getInfo hides port mappings) — it must fail LOUD, not silently wrong.
      await expect(
        p2.spawn(
          { provider: 'boxlite', providerSandboxId: handle.providerSandboxId },
          { tty: false, cmd: ['true'] },
        ),
      ).rejects.toThrow(/no forwarded agent port/i);

      // (B) stop→restart: write to a rootfs path, stop, start, read it back.
      await collect(
        await p1.spawn(handle, {
          tty: false,
          cmd: ['sh', '-c', 'echo ROOTFS_PERSIST > /home/gem/persist.txt'],
        }),
      );
      await p1.stop(handle);
      await p1.start(handle); // re-polls readiness on the SAME forwarded port
      const s3 = await p1.spawn(handle, { tty: false, cmd: ['cat', '/home/gem/persist.txt'] });
      expect((await collect(s3)).out).toContain('ROOTFS_PERSIST');

      await p1.destroy(handle);
      createdBoxIds.delete(handle.providerSandboxId);
    }, 420_000);
  },
);
