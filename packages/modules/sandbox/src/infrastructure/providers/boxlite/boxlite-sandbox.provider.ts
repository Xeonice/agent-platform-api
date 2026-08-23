import { createServer } from 'node:net';
import { Injectable } from '@nestjs/common';
import {
  SandboxProviderError,
  SandboxProviderErrorCode,
  type ProcessSpec,
  type ProcessStream,
  type SandboxFiles,
  type SandboxHandle,
  type SandboxJobs,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SandboxProviderContext,
  type SandboxRuntimeLifecycleState,
  type SandboxRuntimeStatus,
} from '@platform/contracts';
import { AioSandboxAgentClient } from '../aio/aio-sandbox-agent.client';
import { AgentSandboxFiles, AgentSandboxJobs } from '../aio/agent-data-plane';
import {
  assertAgentRejectsAnonymous,
  authHeader,
  createAgentAuthMaterial,
  withAgentAuthEnv,
  withJobSurvivalEnv,
} from '../aio/agent-auth';
import { getSharedBoxliteRuntime, type BoxliteBox, type BoxliteRuntime } from './boxlite-runtime';
import { platformInstanceId } from '../../reconcile/instance-id';

const AGENT_GUEST_PORT = 8080;

/**
 * `boxlite` — micro-VM provider (docs/backend/04 §2.1, SANDBOX-RUNTIME-DECISIONS
 * 决策 B). CONTROL plane = the BoxLite micro-VM SDK (`@boxlite-ai/boxlite`): each
 * Box is an independent-kernel micro-VM (Apple Hypervisor.framework on macOS),
 * NOT a docker container — this is the strong-isolation tier, not just a label.
 * DATA plane = the SHARED in-sandbox AIO agent on `:8080`, reached via BoxLite
 * port-forwarding to a host loopback port (reuses `AioSandboxAgentClient` — the
 * exact same terminal/exec path as `aio`, per 决策 A), guarded by the same
 * per-sandbox agent token (ADR 安全姿态) since that forwarded port is reachable by
 * every local process on the host.
 *
 * The OCI image is pulled through a LOCAL registry mirror (ADR 工程注记: BoxLite's
 * own image store has no resumable downloads, so large images are staged via
 * `localhost:5001`). `docker.io` is retained in `imageRegistries` so the micro-VM
 * bootstrap base (`debian:bookworm-slim`) still resolves.
 */
@Injectable()
export class BoxliteSandboxProvider implements SandboxProvider {
  readonly name = 'boxlite';
  readonly capabilities: SandboxProviderCapabilities = {
    spawnTty: true,
    volumeMount: true,
    updateResources: false,
    pauseResume: false,
    snapshot: false,
    watchEvents: true,
    headlessTask: true,
  };

  /**
   * The two optional planes (04 §2.6), over the SAME in-sandbox agent `aio` uses —
   * only the origin differs (a forwarded host loopback port instead of a published
   * container port), which is why the implementation is shared rather than copied.
   */
  readonly jobs: SandboxJobs = new AgentSandboxJobs(this.name, (handle) =>
    Promise.resolve(new AioSandboxAgentClient(this.agentBase(handle), handle.agentAuthToken)),
  );
  readonly files: SandboxFiles = new AgentSandboxFiles(this.name, (handle) =>
    Promise.resolve(new AioSandboxAgentClient(this.agentBase(handle), handle.agentAuthToken)),
  );

  /** One shared BoxLite runtime per OS process (BoxLite one-runtime-per-home lock). */
  private getRuntime(): Promise<BoxliteRuntime> {
    return getSharedBoxliteRuntime();
  }

  async create(ctx: SandboxProviderContext): Promise<SandboxHandle> {
    return this.guard(async () => {
      const runtime = await this.getRuntime();
      const hostPort = await freeLoopbackPort();
      // per-sandbox agent credential: public half boots the image's auth gateway,
      // token half travels on the handle and is persisted with the sandbox.
      const auth = createAgentAuthMaterial(ctx.sandboxId);
      const box = await runtime.create(
        {
          image: ctx.image.ref,
          memoryMib: ctx.quota.ramMb,
          cpus: ctx.quota.cores,
          autoRemove: false,
          // detached: the micro-VM (and its host port-forward) SURVIVES the backend
          // process exiting — parity with aio's docker container. Proven: a fresh
          // process reconnects to the box by id and the forwarded port still serves
          // the agent. Combined with persisting `agentEndpointPort`, terminal/exec
          // reconnect after a backend restart.
          detach: true,
          // 生存义务 (04 §2.6 ★★★): the agent reads its session TTL / session cap at
          // BOOT, so declaring `headlessTask` obliges us to raise both HERE — polling a
          // job does NOT refresh the reaper's clock (measured).
          env: Object.entries(withJobSurvivalEnv(withAgentAuthEnv(ctx.env, auth))).map(
            ([key, value]) => ({ key, value }),
          ),
          volumes: (ctx.volumes ?? []).map((v) => ({
            hostPath: v.source,
            guestPath: v.target,
            readOnly: v.mode === 'ro',
          })),
          // forward the guest agent :8080 to a host LOOPBACK port only; loopback is
          // NOT the access control (every local process shares it) — the agent's own
          // auth gateway keyed by `auth` above is (ADR 安全姿态).
          ports: [{ hostPort, guestPort: AGENT_GUEST_PORT, hostIp: '127.0.0.1' }],
        },
        this.boxName(ctx.sandboxId),
      );
      // the forwarded port is persisted by the platform (SandboxHandle.agentEndpointPort)
      // — BoxLite `getInfo` does not surface port mappings, so it cannot be re-derived.
      return {
        provider: this.name,
        providerSandboxId: box.id,
        agentEndpointPort: hostPort,
        agentAuthToken: auth.token,
      };
    });
  }

  async start(handle: SandboxHandle): Promise<void> {
    return this.guard(async () => {
      const box = await this.requireBox(handle);
      if (!box.info().state.running) {
        await box.start();
      }
      // agent readiness gate (决策 A / 03): the micro-VM boots before the in-sandbox
      // agent HTTP server accepts connections on the forwarded port.
      await this.waitForAgent(this.agentBase(handle), handle.agentAuthToken);
    });
  }

  async stop(handle: SandboxHandle): Promise<void> {
    return this.guard(async () => {
      const box = await this.findBox(handle);
      if (box) await box.stop();
    });
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    return this.guard(async () => {
      const runtime = await this.getRuntime();
      await runtime.remove(handle.providerSandboxId, true).catch((e: unknown) => {
        // already gone ⇒ idempotent (04 §2.2)
        if (!/not found|no such|unknown/i.test((e as Error).message)) throw e;
      });
    });
  }

  async inspect(handle: SandboxHandle): Promise<SandboxRuntimeStatus> {
    try {
      const runtime = await this.getRuntime();
      const info = await runtime.getInfo(handle.providerSandboxId);
      if (!info) return { lifecycleState: 'instance_missing' };
      return { lifecycleState: this.mapState(info.state.status, info.state.running), raw: info };
    } catch (e) {
      throw this.toProviderError(e);
    }
  }

  async spawn(handle: SandboxHandle, spec: ProcessSpec): Promise<ProcessStream> {
    return this.guard(async () => {
      // data plane = the shared in-sandbox AIO agent over the forwarded loopback port.
      const client = new AioSandboxAgentClient(this.agentBase(handle), handle.agentAuthToken);
      return spec.tty
        ? client.openTerminal(spec.cols ?? 80, spec.rows ?? 24, spec.cmd)
        : client.exec(spec);
    });
  }

  /**
   * micro-VM 的名字里编进**实例指纹**。boxlite 没有 docker 那样的标签机制,名字是
   * 唯一能带身份的地方 —— 而启动对账要靠它区分"这个 box 归谁管"(见
   * `reconcile/instance-id.ts`:不加区分的话,e2e 一跑就把开发者 demo 的 box 全清了)。
   *
   * ⚠️ 格式与 `RuntimeReconciler` 的 `minePrefix` **必须同源**,改一处就要改另一处;
   * 下面的单测把两边钉在一起。
   */
  private boxName(sandboxId: string): string {
    return `platform-${this.name}-${platformInstanceId()}-${sandboxId}`;
  }

  private agentBase(handle: SandboxHandle): string {
    // the forwarded port travels on the handle (persisted by the platform), so this
    // works across a backend restart — no in-process state required.
    const port = handle.agentEndpointPort;
    if (!port) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INVALID_STATE,
        `no forwarded agent port on handle for box ${handle.providerSandboxId}`,
      );
    }
    return `http://127.0.0.1:${port}`;
  }

  private async requireBox(handle: SandboxHandle): Promise<BoxliteBox> {
    const box = await this.findBox(handle);
    if (!box) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.NOT_FOUND,
        `box ${handle.providerSandboxId} not found`,
      );
    }
    return box;
  }

  private async findBox(handle: SandboxHandle): Promise<BoxliteBox | null> {
    const runtime = await this.getRuntime();
    return runtime.get(handle.providerSandboxId);
  }

  private mapState(status: string, running: boolean): SandboxRuntimeLifecycleState {
    if (running) return 'instance_running';
    switch (status.toLowerCase()) {
      case 'created':
        return 'instance_creating';
      case 'paused':
        return 'instance_paused';
      case 'exited':
      case 'stopped':
        return 'instance_exited';
      case 'dead':
        return 'instance_dead';
      default:
        return 'instance_missing';
    }
  }

  /**
   * Poll the forwarded agent port until it answers. With a token, readiness means
   * an AUTHENTICATED 2xx (front door + auth backend + injected key all live), and
   * an anonymous request must be refused — otherwise the image is not enforcing the
   * gateway and we refuse to run (see `assertAgentRejectsAnonymous`).
   * Budget is generous: a COLD BoxLite store pulls the (large) image during first
   * boot — measured ~220s for the AIO image — before the agent listens.
   */
  private async waitForAgent(
    base: string,
    token: string | undefined,
    attempts = 720,
    intervalMs = 500,
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(`${base}/`, { method: 'GET', headers: authHeader(token) });
        if (token === undefined || res.status < 400) {
          await assertAgentRejectsAnonymous(base, token);
          return;
        }
      } catch {
        /* not ready yet */
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new SandboxProviderError(
      SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
      `in-sandbox agent (boxlite) at ${base} did not become ready`,
      undefined,
      true,
    );
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw this.toProviderError(e);
    }
  }

  private toProviderError(e: unknown): SandboxProviderError {
    if (e instanceof SandboxProviderError) return e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found|no such|unknown/i.test(msg)) {
      return new SandboxProviderError(SandboxProviderErrorCode.NOT_FOUND, msg, e);
    }
    if (/manifest unknown|pull|registry|image/i.test(msg)) {
      return new SandboxProviderError(SandboxProviderErrorCode.IMAGE_PULL_FAILED, msg, e);
    }
    return new SandboxProviderError(SandboxProviderErrorCode.INTERNAL, msg, e);
  }
}

/** Reserve an ephemeral loopback port (best-effort; small TOCTOU window). */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('could not allocate a host port'))));
    });
  });
}
