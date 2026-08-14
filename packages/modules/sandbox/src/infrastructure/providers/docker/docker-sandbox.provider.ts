import type Docker from 'dockerode';
import { PassThrough, type Writable } from 'node:stream';
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

export interface DockerProviderConfig {
  name: string;
  capabilities: SandboxProviderCapabilities;
  /** keeps a plain image alive so `spawn` has something to exec into. */
  keepAliveCmd: string[];
  /** provider-distinguishing label (isolation flavour placeholder for S1). */
  isolationLabel: string;
}

/**
 * Docker-backed SandboxProvider (docs/backend/04 §2). BOTH built-in providers use
 * this in S1 (aio default + boxlite), differing only by config/labels/image — the
 * "independent micro-VM kernel" strong isolation for boxlite lands later. The 6
 * required methods map to container create/start/stop/rm/inspect/exec; `spawn`
 * is the single process primitive (tty flag = one-shot vs interactive).
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
      const container = await this.docker.createContainer({
        name: this.containerName(ctx.sandboxId),
        Image: ctx.image.ref,
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
        HostConfig: {
          Binds: binds.length ? binds : undefined,
          Memory: ctx.quota.ramMb * 1024 * 1024,
          NanoCpus: Math.round(ctx.quota.cores * 1e9),
          AutoRemove: false,
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
        if (this.statusCode(e) === 304) return; // already started — idempotent (04 §2.2)
        throw e;
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
      const container = this.docker.getContainer(handle.providerSandboxId);
      const exec = await container.exec({
        Cmd: spec.cmd,
        Tty: spec.tty,
        AttachStdin: spec.tty,
        AttachStdout: true,
        AttachStderr: true,
        Env: spec.env ? Object.entries(spec.env).map(([k, v]) => `${k}=${v}`) : undefined,
        WorkingDir: spec.cwd,
        User: spec.user,
      });
      const stream = await exec.start({ hijack: true, stdin: spec.tty, Tty: spec.tty });
      return new DockerProcessStream(this.docker, exec.id, stream, spec.tty);
    });
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

/** Wraps a docker exec stream as the neutral ProcessStream (04 §2.4). */
class DockerProcessStream implements ProcessStream {
  readonly ref: string;
  private readonly dataCbs: ((chunk: Buffer) => void)[] = [];
  private readonly exitCbs: ((code: number | null) => void)[] = [];

  constructor(
    private readonly docker: Docker,
    execId: string,
    private readonly stream: NodeJS.ReadWriteStream,
    tty: boolean,
  ) {
    this.ref = execId;
    if (tty) {
      // tty mode is a single merged stream — no 8-byte demux header (06 §3)
      this.stream.on('data', (chunk: Buffer) => this.emit(chunk));
    } else {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.on('data', (chunk: Buffer) => this.emit(chunk));
      stderr.on('data', (chunk: Buffer) => this.emit(chunk));
      this.docker.modem.demuxStream(this.stream, stdout as Writable, stderr as Writable);
    }
    this.stream.on('end', () => {
      void this.reportExit(execId);
    });
  }

  private emit(chunk: Buffer): void {
    for (const cb of this.dataCbs) cb(chunk);
  }

  private async reportExit(execId: string): Promise<void> {
    let code: number | null = null;
    try {
      const info = await this.docker.getExec(execId).inspect();
      code = info.ExitCode ?? null;
    } catch {
      code = null;
    }
    for (const cb of this.exitCbs) cb(code);
  }

  onData(cb: (chunk: Buffer) => void): void {
    this.dataCbs.push(cb);
  }

  write(data: string | Buffer): void {
    this.stream.write(data);
  }

  resize(cols: number, rows: number): void {
    void this.docker
      .getExec(this.ref)
      .resize({ w: cols, h: rows })
      .catch(() => undefined);
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCbs.push(cb);
  }

  async kill(): Promise<void> {
    // exec has no direct kill; end the attach stream (session detach, 06 §6)
    this.stream.end();
  }
}
