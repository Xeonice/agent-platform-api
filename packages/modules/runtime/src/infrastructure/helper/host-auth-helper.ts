import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import type { ProcessStream } from '@platform/contracts';
import type {
  AuthHelper,
  AuthHelperSession,
  HelperSeedFile,
} from '../../domain/ports/auth-helper.port';

/**
 * Host-form AuthHelper (docs/backend/11 §1.1 form ②): runs the login CLI directly via
 * `child_process`. The default production form is the AIO helper CONTAINER via
 * `SandboxProvider.spawn({tty:true})` — swapped by DI without touching the app layer.
 *
 * Per-op isolation (P1-3,照搬 git-auth.materializer): each session gets a FRESH
 * `mkdtemp` HOME wired as HOME = CLAUDE_CONFIG_DIR = CODEX_HOME so concurrent
 * logins/refreshes never cross credential dirs; `dispose()` kills the process and
 * `rm -rf`s the temp HOME (the `finally` must-delete). NOTE: this host form is not a
 * real TTY; the setup-token/device-auth CLIs detect TTY, so the CONTAINER form (real
 * pty) is the production path — the host form backs offline/bare-metal deploys and
 * is exercised in tests via a substituted fake ProcessStream.
 */
@Injectable()
export class HostAuthHelper implements AuthHelper {
  private readonly logger = new Logger('HostAuthHelper');

  async openSession(cmd: string[], seed: HelperSeedFile[] = []): Promise<AuthHelperSession> {
    const base = join(process.env.DATA_ROOT ?? tmpdir(), 'auth-helper');
    await mkdir(base, { recursive: true, mode: 0o700 });
    const homeDir = await mkdtemp(join(base, 'h-'));
    for (const f of seed) {
      await writeFile(join(homeDir, f.relPath), f.content, { mode: f.mode ?? 0o600 });
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      CLAUDE_CONFIG_DIR: homeDir,
      CODEX_HOME: homeDir,
    };
    const child = spawn(cmd[0], cmd.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const pty = new ChildProcessStream(child);
    return {
      pty,
      homeDir,
      dispose: async () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        await rm(homeDir, { recursive: true, force: true }).catch((e) =>
          this.logger.warn(`failed to remove helper HOME ${homeDir}: ${(e as Error).message}`),
        );
      },
    };
  }
}

/** Wraps a `child_process` as the neutral `ProcessStream` (04 §2.4). */
class ChildProcessStream implements ProcessStream {
  readonly ref: string;
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.ref = `helper-${child.pid ?? 'na'}`;
  }
  onData(cb: (chunk: Buffer) => void): void {
    this.child.stdout.on('data', (c: Buffer) => cb(c));
    this.child.stderr.on('data', (c: Buffer) => cb(c));
  }
  write(data: string | Buffer): void {
    this.child.stdin.write(data);
  }
  resize(): void {
    /* not a real pty in the host form */
  }
  onExit(cb: (code: number | null) => void): void {
    this.child.on('exit', (code) => cb(code));
  }
  async kill(signal?: NodeJS.Signals): Promise<void> {
    this.child.kill(signal ?? 'SIGTERM');
  }

  /** 松手但不发信号:让宿主子进程按自己的节奏结束(detach ≠ kill)。 */
  detach(): void {
    this.child.unref();
  }
}
