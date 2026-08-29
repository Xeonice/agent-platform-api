import { describe, it, expect } from 'vitest';
import { SandboxProviderErrorCode } from '@platform/contracts';
import { DockerContainerRuntime } from '../../src/infrastructure/providers/docker/docker-container-runtime';
import type { ContainerCreateSpec } from '../../src/infrastructure/providers/container-runtime.port';

/**
 * 04 §7 时刻④ AT THE CONTROL-PLANE EDGE: what string actually reaches the container
 * runtime, and how a pinned-but-missing digest is classified.
 *
 * Both halves only exist because the platform now pulls `ref@digest`. The first is
 * the payoff — steps ①②③ freeze a coordinate, and this is where it becomes real. The
 * second is the price: a failure mode that following a tag simply did not have.
 *
 * ⚠️ 被测对象从 `DockerContainerBackend`（既是 provider 又是 docker 机制又是
 * `docker exec` 数据面）换成了 `DockerContainerRuntime`（只有控制面）。断言的**事实
 * 没变**：交给 daemon 的那个字符串，以及 404 的分类。
 */
const DIGEST = `sha256:${'b'.repeat(64)}`;

interface CreateArgs {
  Image?: string;
  Cmd?: string[];
  HostConfig?: { PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[]> };
}

function specFor(digest: string): ContainerCreateSpec {
  return {
    sandboxId: 'sbx-1',
    instanceName: 'platform-aio-sbx-1',
    quota: { cores: 1, ramMb: 512, diskMb: 1024 },
    image: { ref: 'ghcr.io/agent-infra/sandbox:latest', digest },
    env: {},
    labels: {},
    volumes: [],
    agentPort: 8080,
  };
}

function runtime(onCreate: (args: CreateArgs) => unknown): DockerContainerRuntime {
  const docker = {
    createContainer: (args: CreateArgs) => Promise.resolve(onCreate(args)),
  };
  return new DockerContainerRuntime(docker as never);
}

describe('the control plane pulls BITS, not a tag', () => {
  it('hands docker `ref@digest` when a real digest was frozen', async () => {
    let seen: CreateArgs = {};
    await runtime((args) => {
      seen = args;
      return { id: 'c1' };
    }).create(specFor(DIGEST));
    // ⚠️ WITHOUT THIS LINE THE WHOLE SLICE IS BOOKKEEPING. `:latest` can be re-pushed
    // between two Task creations, and a platform that passes the tag runs different
    // bits while recording an unchanged string (04 §7 ★ 三条后果).
    expect(seen.Image).toBe(`ghcr.io/agent-infra/sandbox:latest@${DIGEST}`);
  });

  it('falls back to the bare tag for a pre-slice row with no recoverable digest', async () => {
    let seen: CreateArgs = {};
    await runtime((args) => {
      seen = args;
      return { id: 'c1' };
    }).create(specFor(''));
    // Emitting `…:latest@sha256:unresolved` would be an UNPULLABLE reference — the
    // placeholder turned from useless into actively breaking (13 §2.1 迁移).
    expect(seen.Image).toBe('ghcr.io/agent-infra/sandbox:latest');
  });

  it('never overrides the image entrypoint, and publishes the agent port to LOOPBACK only', async () => {
    let seen: CreateArgs = {};
    await runtime((args) => {
      seen = args;
      return { id: 'c1' };
    }).create(specFor(DIGEST));
    // ⚠️ A `Cmd` here would replace the AIO entrypoint — the very thing that starts
    // the `:8080` agent. The container would be "running" and permanently unreachable.
    expect(seen.Cmd).toBeUndefined();
    // ⚠️ `HostIp: ''` (docker's default) binds 0.0.0.0 — the sandbox shell would be
    // reachable from the network, not just from this host.
    expect(seen.HostConfig?.PortBindings?.['8080/tcp']).toEqual([
      { HostIp: '127.0.0.1', HostPort: '' },
    ]);
  });
});

describe('a pinned digest that is gone upstream gets its OWN code', () => {
  it('classifies a 404 about a digest as IMAGE_DIGEST_GONE, not NOT_FOUND', async () => {
    const err = Object.assign(
      new Error(`(HTTP code 404) no such container - No such image: img@${DIGEST}`),
      { statusCode: 404 },
    );
    const thrown = await runtime(() => {
      throw err;
    })
      .create(specFor(DIGEST))
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
    const thrown = await runtime(() => {
      throw err;
    })
      .create(specFor(DIGEST))
      .catch((e: unknown) => e);
    expect((thrown as { code: string }).code).toBe(SandboxProviderErrorCode.NOT_FOUND);
  });
});
