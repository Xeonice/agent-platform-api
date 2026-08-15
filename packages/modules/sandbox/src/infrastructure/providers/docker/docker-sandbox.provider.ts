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

export interface DockerProviderConfig {
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
   * LOOPBACK-only host port (never an external interface); `spawn` then goes
   * through `AioSandboxAgentClient`. When unset, `spawn` falls back to
   * `docker exec` (`DockerExecAgentClient`).
   */
  agentPort?: number;
}

/**
 * Docker-backed SandboxProvider CONTROL PLANE (docs/backend/04 §2 + ADR 决策 A).
 * The 6 required methods map to container create/start/stop/rm/inspect. The DATA
 * plane (`spawn`) is agent-first: when `agentPort` is configured the process/pty
 * comes from the in-sandbox AIO agent; otherwise it falls back to `docker exec`.
 * boxlite reuses this control plane in P1 (BoxLite micro-VM control plane lands in
 * P2); the agent data plane is shared across both.
 */
export class DockerSandboxProvider implements SandboxProvider {
  readonly name: string;
  readonly capabilities: SandboxProviderCapabilities;

  constructor(
    private readonly docker: Docker,
    private readonly config: DockerProviderConfig,
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
        Env: Object.entries(ctx.env).map(([k, v]) => `${k}=${v}`),
        ExposedPorts: portKey ? { [portKey]: {} } : undefined,
        HostConfig: {
          Binds: binds.length ? binds : undefined,
          Memory: ctx.quota.ramMb * 1024 * 1024,
          NanoCpus: Math.round(ctx.quota.cores * 1e9),
          AutoRemove: false,
          // publish the agent port to LOOPBACK ONLY (HostIp 127.0.0.1), never an
          // external interface — the agent is an unauthenticated shell (ADR 安全姿态).
          // Empty HostPort = kernel-assigned ephemeral port, resolved at spawn time.
          PortBindings: portKey
            ? { [portKey]: [{ HostIp: '127.0.0.1', HostPort: '' }] }
            : undefined,
        },
      });
      return { provider: this.name, providerSandboxId: container.id };
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
        await this.waitForAgent(base);
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
        const client = new AioSandboxAgentClient(base);
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
   * Poll the agent HTTP origin until it accepts a connection (ANY HTTP response
   * proves the server is listening — AIO has no dedicated health route, `/`
   * returns 200). Uses a fixed attempt/interval loop (no wall clock — Date.now()
   * is banned in infrastructure).
   */
  private async waitForAgent(base: string, attempts = 80, intervalMs = 250): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await fetch(`${base}/`, { method: 'GET' });
        return; // reachable → agent server is up
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
