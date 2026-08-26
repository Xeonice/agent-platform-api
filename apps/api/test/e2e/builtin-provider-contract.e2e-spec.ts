import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSandboxProviderContractTests } from '@platform/contracts/testkit';
import type { SandboxProviderContext } from '@platform/contracts';
import {
  createDockerClient,
  isDockerAvailable,
} from '../../../../packages/modules/sandbox/src/infrastructure/providers/docker/docker-client';
import { AioSandboxProvider } from '../../../../packages/modules/sandbox/src/infrastructure/providers/aio/aio-sandbox.provider';
import { BoxliteSandboxProvider } from '../../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-sandbox.provider';

/**
 * The LIVE half of the built-in providers' golden contract run (docs/backend/04 §10).
 * Same `runSandboxProviderContractTests` the fake and any third-party provider run —
 * here handed a real `SandboxProviderContext`, which switches the live clauses (SP-01:
 * `create()` → `handle.provider === provider.name` → `destroy()`) on.
 *
 * It lives in the `e2e` project rather than `contract` for two reasons: it needs a
 * reachable host, and BoxLite permits only ONE runtime per BOXLITE_HOME ACROSS
 * processes — `e2e` is the single-fork project that serializes that (vitest.workspace).
 * The host-free clauses (SP-00 / CAP-01) run unconditionally in
 * `packages/modules/sandbox/test/contract/builtin-providers.contract.spec.ts`.
 *
 * Missing prerequisites SKIP LOUDLY — never a silent fake pass.
 */
const DOCKER_IMAGE = process.env.SANDBOX_TEST_IMAGE ?? 'alpine:3.20';
const BOXLITE_REGISTRY = process.env.SANDBOX_BOXLITE_REGISTRY ?? 'localhost:5001';
const BOXLITE_IMAGE =
  process.env.SANDBOX_BOXLITE_TEST_IMAGE ?? `${BOXLITE_REGISTRY}/agent-infra/sandbox:latest`;

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
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`http://${BOXLITE_REGISTRY}/v2/agent-infra/sandbox/tags/list`, {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const body = (await res.json()) as { tags?: string[] };
    return Array.isArray(body.tags) && body.tags.includes('latest');
  } catch {
    return false;
  }
}

function contextFor(sandboxId: string, imageRef: string): SandboxProviderContext {
  return {
    sandboxId,
    quota: { cores: 1, ramMb: 1024, diskMb: 2048 },
    image: { ref: imageRef, digest: 'sha256:contract-live' },
    env: {},
    volumes: [],
    labels: { 'platform.managed': 'true' },
  };
}

const docker = createDockerClient();
const dockerUp = await isDockerAvailable(docker).catch(() => false);

/** `create()` needs the image locally present — the backend never pulls. */
async function pullDockerImage(): Promise<boolean> {
  try {
    await new Promise<void>((done, fail) => {
      docker.pull(DOCKER_IMAGE, (err: unknown, stream: NodeJS.ReadableStream) => {
        if (err) return fail(err instanceof Error ? err : new Error(String(err)));
        docker.modem.followProgress(stream, (e: unknown) =>
          e ? fail(e instanceof Error ? e : new Error(String(e))) : done(),
        );
      });
    });
    return true;
  } catch {
    return false;
  }
}

const aioReady = dockerUp && (await pullDockerImage());
if (!aioReady) {
  console.warn(
    '\n\x1b[33m========================================================================\n' +
      '[builtin-provider-contract.e2e] aio LIVE contract clauses SKIPPED —\n' +
      `docker daemon reachable: ${dockerUp} (DOCKER_HOST=${process.env.DOCKER_HOST ?? 'default socket'});\n` +
      `${DOCKER_IMAGE} pullable: ${dockerUp ? 'no' : 'n/a'}.\n` +
      'The host-free clauses still ran in the contract project. NOT fake-passed.\n' +
      '========================================================================\x1b[0m\n',
  );
}

const boxliteReady = boxliteBinaryPresent() && (await registryServingImage());
if (!boxliteReady) {
  console.warn(
    '\n\x1b[33m========================================================================\n' +
      '[builtin-provider-contract.e2e] boxlite LIVE contract clauses SKIPPED —\n' +
      `BoxLite binary present: ${boxliteBinaryPresent()}; registry ${BOXLITE_REGISTRY}\n` +
      'serving agent-infra/sandbox:latest: false-or-unreachable.\n' +
      'The host-free clauses still ran in the contract project. NOT fake-passed.\n' +
      '========================================================================\x1b[0m\n',
  );
}

/**
 * ── 数据面条款（DP-\*）的 fixture ──────────────────────────────────────────────
 *
 * 与 SP-01 的 `context` **分开**：SP-01 只 create+destroy，一张 `alpine` 就够；
 * DP-\* 要 create → **start** → 真跑数据面 → destroy，裸镜像会直接卡在就绪门槛上
 * （aio 的 `start()` 要等沙箱内 agent 应答，alpine 里根本没有那个东西）。
 *
 * 两个 provider 用**同一张**带数据面的镜像 `agent-infra/sandbox:latest`——同一套条款、
 * 同一个 fixture，没有双重标准（04 §10）。aio 侧要求 docker 本地已有这张镜像；
 * 它比 `alpine` 大得多，所以**不主动 pull**，缺了就响亮 skip。
 */
const AIO_DATAPLANE_IMAGE = process.env.SANDBOX_AIO_DATAPLANE_IMAGE ?? BOXLITE_IMAGE;

async function dockerHasImage(ref: string): Promise<boolean> {
  try {
    await docker.getImage(ref).inspect();
    return true;
  } catch {
    return false;
  }
}

const aioDataPlaneReady = aioReady && (await dockerHasImage(AIO_DATAPLANE_IMAGE));
if (aioReady && !aioDataPlaneReady) {
  console.warn(
    '\n\x1b[33m========================================================================\n' +
      `[builtin-provider-contract.e2e] aio DATA-PLANE clauses SKIPPED — docker has no\n` +
      `local image ${AIO_DATAPLANE_IMAGE}. Stage it with:\n` +
      `  docker pull ${AIO_DATAPLANE_IMAGE}\n` +
      'The lifecycle clause (SP-01) still ran. NOT fake-passed.\n' +
      '========================================================================\x1b[0m\n',
  );
}

runSandboxProviderContractTests(
  'aio (built-in, live docker)',
  () => new AioSandboxProvider(docker),
  {
    context: aioReady ? contextFor(`ctr-aio-${Date.now()}`, DOCKER_IMAGE) : undefined,
    skipLiveReason: `docker daemon or ${DOCKER_IMAGE} unavailable`,
    dataPlaneContext: aioDataPlaneReady
      ? contextFor(`dp-aio-${Date.now()}`, AIO_DATAPLANE_IMAGE)
      : undefined,
    skipDataPlaneReason: `docker has no local ${AIO_DATAPLANE_IMAGE}`,
  },
);

runSandboxProviderContractTests(
  'boxlite (built-in, live micro-VM)',
  () => new BoxliteSandboxProvider(),
  {
    context: boxliteReady ? contextFor(`ctr-bl-${Date.now()}`, BOXLITE_IMAGE) : undefined,
    skipLiveReason: `BoxLite binary or ${BOXLITE_REGISTRY} image missing`,
    dataPlaneContext: boxliteReady ? contextFor(`dp-bl-${Date.now()}`, BOXLITE_IMAGE) : undefined,
    skipDataPlaneReason: `BoxLite binary or ${BOXLITE_REGISTRY} image missing`,
  },
);
