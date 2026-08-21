import type Docker from 'dockerode';
import {
  SandboxProviderError,
  SandboxProviderErrorCode,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SandboxProviderContext,
  type SandboxHandle,
  type SandboxRuntimeStatus,
  type SandboxRuntimeLifecycleState,
  type ProcessSpec,
  type ProcessStream,
} from '@platform/contracts';
import { DockerExecAgentClient } from './docker-exec-agent.client';
import { AioSandboxAgentClient } from '../aio/aio-sandbox-agent.client';
import {
  assertAgentRejectsAnonymous,
  authHeader,
  createAgentAuthMaterial,
  withAgentAuthEnv,
} from '../aio/agent-auth';

export interface DockerContainerConfig {
  name: string;
  capabilities: SandboxProviderCapabilities;
  /**
   * Keep a bare (agent-less) image alive so `spawn` has something to exec into.
   * OMIT for images with a built-in agent (AIO Sandbox) — their default
   * entrypoint starts the `:8080` agent server and must not be overridden.
   */
  keepAliveCmd?: string[];
  /** provider-distinguishing label (isolation flavour). */
  isolationLabel: string;
  /**
   * When set, this image ships an in-sandbox agent listening on this TCP port
   * (SANDBOX-RUNTIME-DECISIONS 决策 A). The container exposes it on a
   * LOOPBACK-only host port (never an external interface) AND is booted with the
   * agent's own auth gateway on, so the port is not an open shell for other local
   * processes; `spawn` then goes through `AioSandboxAgentClient`. When unset,
   * `spawn` falls back to `docker exec` (`DockerExecAgentClient`).
   */
  agentPort?: number;
}

/**
 * `aio` 的 Docker 容器后端 —— **不是**一个注册的沙箱方案。
 *
 * 注册的方案就是 `aio` + `boxlite`（见 registry）；这里是 `AioSandboxProvider`
 * 赖以实现的具体 Docker 容器机制，也是开发机上一个方便的**本机/测试运行时**。
 * Docker 不会泄到这一层之外——对外的 SPI/REST/MCP 保持运行时无关（ADR：服务
 * 对外是纯粹的沙箱抽象）。
 *
 * 控制面：6 个 SPI 方法经 dockerode 映射到容器 create/start/stop/rm/inspect。
 * 数据面（`spawn`）agent 优先：设了 `agentPort` 则 pty/exec 来自沙箱内 AIO agent；
 * 未设则退回 `docker exec`（`DockerExecAgentClient`，仅给无 agent 的裸镜像）。
 */
export class DockerContainerBackend implements SandboxProvider {
  readonly name: string;
  readonly capabilities: SandboxProviderCapabilities;

  constructor(
    private readonly docker: Docker,
    private readonly config: DockerContainerConfig,
  ) {
    this.name = config.name;
    this.capabilities = config.capabilities;
  }

  private containerName(sandboxId: string): string {
    return `platform-${this.name}-${sandboxId}`;
  }

  async create(ctx: SandboxProviderContext): Promise<SandboxHandle> {
    return this.guard(async () => {
      const binds = (ctx.volumes ?? []).map((v) => `${v.source}:${v.target}:${v.mode}`);
      const agentPort = this.config.agentPort;
      const portKey = agentPort ? `${agentPort}/tcp` : undefined;
      // An agent image gets a per-sandbox credential: the public half boots the
      // image's own auth gateway, the token half travels on the handle. Without it
      // the loopback-published port is an unauthenticated shell for every local
      // process on the host (ADR 安全姿态). Bare images have no agent to protect.
      const auth = agentPort !== undefined ? createAgentAuthMaterial(ctx.sandboxId) : undefined;
      const env = auth ? withAgentAuthEnv(ctx.env, auth) : ctx.env;
      const container = await this.docker.createContainer({
        name: this.containerName(ctx.sandboxId),
        Image: ctx.image.ref,
        // agent images keep their own entrypoint (starts :8080); only bare images
        // need an explicit keep-alive command.
        Cmd: this.config.keepAliveCmd,
        Tty: false,
        OpenStdin: false,
        Labels: {
          ...(ctx.labels ?? {}),
          'platform.managed': 'true',
          'platform.provider': this.name,
          'platform.isolation': this.config.isolationLabel,
          'platform.sandboxId': ctx.sandboxId,
        },
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
        ExposedPorts: portKey ? { [portKey]: {} } : undefined,
        HostConfig: {
          Binds: binds.length ? binds : undefined,
          Memory: ctx.quota.ramMb * 1024 * 1024,
          NanoCpus: Math.round(ctx.quota.cores * 1e9),
          AutoRemove: false,
          // publish the agent port to LOOPBACK ONLY (HostIp 127.0.0.1), never an
          // external interface. Loopback alone is NOT the access control — every
          // local process shares it — so the agent also runs behind its own auth
          // gateway keyed by the token above (ADR 安全姿态).
          // Empty HostPort = kernel-assigned ephemeral port, resolved at spawn time.
          PortBindings: portKey
            ? { [portKey]: [{ HostIp: '127.0.0.1', HostPort: '' }] }
            : undefined,
        },
      });
      return {
        provider: this.name,
        providerSandboxId: container.id,
        // persisted by the platform: unlike the published port (re-derivable from
        // `docker inspect`) the token cannot be recovered from the daemon, so a
        // backend restart would otherwise lose the only way to talk to the agent.
        agentAuthToken: auth?.token,
      };
    });
  }

  async start(handle: SandboxHandle): Promise<void> {
    return this.guard(async () => {
      try {
        await this.docker.getContainer(handle.providerSandboxId).start();
      } catch (e) {
        if (this.statusCode(e) === 304) {
          // already started — idempotent (04 §2.2); still gate on agent readiness
        } else {
          throw e;
        }
      }
      // agent readiness gate (ADR 决策 A / 03): the container is "running" long
      // before the in-sandbox agent HTTP server accepts connections.
      if (this.config.agentPort !== undefined) {
        const base = await this.resolveAgentHttpBase(handle);
        await this.waitForAgent(base, handle.agentAuthToken);
      }
    });
  }

  async stop(handle: SandboxHandle, opts?: { timeoutSec?: number }): Promise<void> {
    return this.guard(async () => {
      try {
        await this.docker
          .getContainer(handle.providerSandboxId)
          .stop({ t: opts?.timeoutSec ?? 10 });
      } catch (e) {
        if (this.statusCode(e) === 304) return; // already stopped
        throw e;
      }
    });
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    return this.guard(async () => {
      try {
        await this.docker.getContainer(handle.providerSandboxId).remove({ force: true });
      } catch (e) {
        if (this.statusCode(e) === 404) return; // already gone — idempotent (04 §2.2)
        throw e;
      }
    });
  }

  async inspect(handle: SandboxHandle): Promise<SandboxRuntimeStatus> {
    try {
      const info = await this.docker.getContainer(handle.providerSandboxId).inspect();
      return {
        lifecycleState: this.mapState(info.State?.Status, info.State?.Running),
        exitCode: info.State?.ExitCode,
        startedAt: info.State?.StartedAt,
        finishedAt: info.State?.FinishedAt,
        raw: info.State,
      };
    } catch (e) {
      // inspect must distinguish "confirmed missing" from "can't reach" (04 §2.2)
      if (this.statusCode(e) === 404) return { lifecycleState: 'instance_missing' };
      throw this.toProviderError(e);
    }
  }

  async spawn(handle: SandboxHandle, spec: ProcessSpec): Promise<ProcessStream> {
    return this.guard(async () => {
      // agent-first data plane (ADR 决策 A): in-sandbox AIO agent when available.
      if (this.config.agentPort !== undefined) {
        const base = await this.resolveAgentHttpBase(handle);
        const client = new AioSandboxAgentClient(base, handle.agentAuthToken);
        return spec.tty ? client.openTerminal(spec.cols ?? 80, spec.rows ?? 24) : client.exec(spec);
      }
      // fallback: agent-less bare image → docker exec.
      const container = this.docker.getContainer(handle.providerSandboxId);
      return new DockerExecAgentClient(this.docker).spawn(container, spec);
    });
  }

  /**
   * Resolve the loopback-published host origin of the in-sandbox agent. On a
   * shared docker network (production, 11 §1) this would instead be
   * `http://<container-ip>:<agentPort>`; for single-host (incl. macOS Docker
   * Desktop, where container IPs are unreachable) we use the published loopback
   * port. Runtime-resolved, never persisted (13 §: agent endpoint not in the DB).
   */
  private async resolveAgentHttpBase(handle: SandboxHandle): Promise<string> {
    const agentPort = this.config.agentPort;
    const info = await this.docker.getContainer(handle.providerSandboxId).inspect();
    const mapping = info.NetworkSettings?.Ports?.[`${agentPort}/tcp`]?.[0];
    if (!mapping?.HostPort) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INVALID_STATE,
        `agent port ${agentPort} is not published for ${handle.providerSandboxId}`,
      );
    }
    const host = mapping.HostIp && mapping.HostIp !== '0.0.0.0' ? mapping.HostIp : '127.0.0.1';
    return `http://${host}:${mapping.HostPort}`;
  }

  /**
   * Poll the agent HTTP origin until it is ready. Without a token ANY HTTP
   * response proves the server is listening (AIO has no dedicated health route,
   * `/` returns 200). WITH a token readiness is stricter — and better: a 2xx on an
   * AUTHENTICATED `/` proves the front door, the auth backend and the injected key
   * are all live, so the first exec cannot race a half-started gateway. Uses a
   * fixed attempt/interval loop (no wall clock — Date.now() is banned here).
   */
  private async waitForAgent(
    base: string,
    token: string | undefined,
    attempts = 80,
    intervalMs = 250,
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(`${base}/`, { method: 'GET', headers: authHeader(token) });
        if (token === undefined || res.status < 400) {
          await assertAgentRejectsAnonymous(base, token);
          return; // reachable → agent server is up
        }
      } catch {
        /* ECONNREFUSED / not yet listening */
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new SandboxProviderError(
      SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
      `in-sandbox agent at ${base} did not become ready`,
      undefined,
      true,
    );
  }

  private mapState(status?: string, running?: boolean): SandboxRuntimeLifecycleState {
    if (running) return 'instance_running';
    switch (status) {
      case 'created':
        return 'instance_creating';
      case 'paused':
        return 'instance_paused';
      case 'exited':
        return 'instance_exited';
      case 'dead':
        return 'instance_dead';
      default:
        return 'instance_missing';
    }
  }

  private statusCode(e: unknown): number | undefined {
    return typeof e === 'object' && e !== null && 'statusCode' in e
      ? (e as { statusCode?: number }).statusCode
      : undefined;
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
    const code = this.statusCode(e);
    const msg = e instanceof Error ? e.message : String(e);
    if (code === 404) {
      return new SandboxProviderError(SandboxProviderErrorCode.NOT_FOUND, msg, e);
    }
    if (code === 409) {
      return new SandboxProviderError(SandboxProviderErrorCode.ALREADY_EXISTS, msg, e);
    }
    // ECONNREFUSED / ENOENT on the socket ⇒ daemon unreachable (04 §4)
    if (/ECONNREFUSED|ENOENT|EAI_AGAIN|socket hang up/i.test(msg)) {
      return new SandboxProviderError(
        SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        `docker daemon unreachable: ${msg}`,
        e,
        true,
      );
    }
    return new SandboxProviderError(SandboxProviderErrorCode.INTERNAL, msg, e);
  }
}
