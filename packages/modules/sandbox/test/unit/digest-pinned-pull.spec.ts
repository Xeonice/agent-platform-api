import { describe, it, expect } from 'vitest';
import { SandboxProviderErrorCode } from '@platform/contracts';
import type { SandboxProviderContext } from '@platform/contracts';
import { DockerContainerBackend } from '../../src/infrastructure/providers/docker/docker-container-backend';

/**
 * 04 §7 时刻④ AT THE PROVIDER EDGE: what string actually reaches the container
 * runtime, and how a pinned-but-missing digest is classified.
 *
 * Both halves only exist because the platform now pulls `ref@digest`. The first is
 * the payoff — steps ①②③ freeze a coordinate, and this is where it becomes real. The
 * second is the price: a failure mode that following a tag simply did not have.
 */
const DIGEST = `sha256:${'b'.repeat(64)}`;

function contextFor(digest: string): SandboxProviderContext {
  return {
    sandboxId: 'sbx-1',
    quota: { cores: 1, ramMb: 512, diskMb: 1024 },
    image: { ref: 'ghcr.io/agent-infra/sandbox:latest', digest },
    env: {},
  };
}

interface CreateArgs {
  Image?: string;
}

function backend(onCreate: (args: CreateArgs) => unknown) {
  const docker = {
    createContainer: (args: CreateArgs) => Promise.resolve(onCreate(args)),
  };
  return new DockerContainerBackend(docker as never, {
    name: 'aio',
    capabilities: {
      spawnTty: true,
      volumeMount: true,
      updateResources: false,
      pauseResume: false,
      snapshot: false,
      watchEvents: false,
      headlessTask: false,
    },
    isolationLabel: 'container',
  });
}

describe('the provider pulls BITS, not a tag', () => {
  it('hands docker `ref@digest` when a real digest was frozen', async () => {
    let seen: CreateArgs = {};
    await backend((args) => {
      seen = args;
      return { id: 'c1' };
    }).create(contextFor(DIGEST));
    // ⚠️ WITHOUT THIS LINE THE WHOLE SLICE IS BOOKKEEPING. `:latest` can be re-pushed
    // between two Task creations, and a platform that passes the tag runs different
    // bits while recording an unchanged string (04 §7 ★ 三条后果).
    expect(seen.Image).toBe(`ghcr.io/agent-infra/sandbox:latest@${DIGEST}`);
  });

  it('falls back to the bare tag for a pre-slice row with no recoverable digest', async () => {
    let seen: CreateArgs = {};
    await backend((args) => {
      seen = args;
      return { id: 'c1' };
    }).create(contextFor(''));
    // Emitting `…:latest@sha256:unresolved` would be an UNPULLABLE reference — the
    // placeholder turned from useless into actively breaking (13 §2.1 迁移).
    expect(seen.Image).toBe('ghcr.io/agent-infra/sandbox:latest');
  });
});

describe('a pinned digest that is gone upstream gets its OWN code', () => {
  it('classifies a 404 about a digest as IMAGE_DIGEST_GONE, not NOT_FOUND', async () => {
    const err = Object.assign(
      new Error(`(HTTP code 404) no such container - No such image: img@${DIGEST}`),
      { statusCode: 404 },
    );
    const thrown = await backend(() => {
      throw err;
    })
      .create(contextFor(DIGEST))
      .catch((e: unknown) => e);
    // ⚠️ THE GENERIC 404 RULE SITS RIGHT BELOW AND WOULD SWALLOW THIS. `NOT_FOUND`
    // sends the user to check the address; here the address is exactly right and the
    // bits behind it were deleted upstream, so editing it and retrying are both
    // useless — the way out is [检查更新] (04 §4 四类分类法).
    expect((thrown as { code: string }).code).toBe(SandboxProviderErrorCode.IMAGE_DIGEST_GONE);
  });

  it('leaves an ordinary 404 as NOT_FOUND', async () => {
    const err = Object.assign(new Error('(HTTP code 404) no such container - abc'), {
      statusCode: 404,
    });
    const thrown = await backend(() => {
      throw err;
    })
      .create(contextFor(DIGEST))
      .catch((e: unknown) => e);
    expect((thrown as { code: string }).code).toBe(SandboxProviderErrorCode.NOT_FOUND);
  });
});
