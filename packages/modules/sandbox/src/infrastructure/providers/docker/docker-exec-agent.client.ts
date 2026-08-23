import type Docker from 'dockerode';
import { PassThrough, type Writable } from 'node:stream';
import type { ProcessSpec, ProcessStream } from '@platform/contracts';

/**
 * FALLBACK data-plane client (SANDBOX-RUNTIME-DECISIONS 决策 A). For BARE images
 * with NO in-sandbox agent (e.g. the alpine test image), exec/pty go through the
 * host `docker exec` and are wrapped as the neutral `ProcessStream`. This is NOT
 * the main path — providers backed by an AIO Sandbox agent use
 * `AioSandboxAgentClient` instead. Kept because it costs nothing and covers the
 * agent-less case.
 */
export class DockerExecAgentClient {
  constructor(private readonly docker: Docker) {}

  async spawn(container: Docker.Container, spec: ProcessSpec): Promise<ProcessStream> {
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
    return new DockerExecProcessStream(this.docker, exec.id, stream, spec.tty);
  }
}

/** Wraps a docker exec stream as the neutral ProcessStream (04 §2.4). */
class DockerExecProcessStream implements ProcessStream {
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

  /**
   * detach 之后不得再报"进程已退出"。与 AIO 那条同一个道理:`detach()` 调的
   * `stream.end()` 会触发构造函数里注册的 `'end'` 监听器 → `reportExit`,
   * 于是"松手"被报成了"退出"。这一位既是那道闸门,也顺带给 reportExit 补上了
   * 它本来就该有的幂等锁(此前重复触发会把回调跑两遍)。
   */
  private detached = false;

  private async reportExit(execId: string): Promise<void> {
    if (this.detached) return;
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

  /**
   * 这条路本来就只有"结束附着"这一个动作,不往对面写任何字节。
   * ⚠️ 先上锁再 end():`end()` 会触发 `'end'` 监听器 → `reportExit`,不挡住的话
   * 上层会收到一次它不该收到的"进程已退出"(理由见 `detached` 字段)。
   */
  detach(): void {
    this.detached = true;
    this.stream.end();
  }
}
