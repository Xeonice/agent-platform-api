import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { parseImageRef, formatImageRef } from '../../packages/contracts/src/image-spec.contract';
import type {
  ImageSpecProvider,
  ImageSpecRegistry,
  ProcessSpec,
  ProcessStream,
  SandboxHandle,
} from '@platform/contracts';
import { ScriptedProvider } from './external-provider';

/** Actual child-process bytes replace only the provider's external PTY transport. */
class NativeTerminal implements ProcessStream {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ref: string;
  detached = false;
  killed = false;
  constructor() {
    this.child = spawn(
      process.execPath,
      [
        '-e',
        String.raw`process.stdout.write('❯ ');process.stdin.on('data',b=>process.stdout.write('accepted:'+b.toString()));`,
      ],
      { stdio: 'pipe' },
    );
    this.ref = `pty-${this.child.pid}`;
  }
  onData(callback: (chunk: Buffer) => void) {
    this.child.stdout.on('data', callback);
  }
  onExit(callback: (code: number | null) => void) {
    this.child.on('exit', callback);
  }
  write(data: string | Buffer) {
    this.child.stdin.write(data);
  }
  resize() {}
  async kill() {
    this.killed = true;
    this.child.kill();
  }
  detach() {
    this.detached = true;
    this.child.stdout.removeAllListeners('data');
    this.child.removeAllListeners('exit');
  }
}
export class ProtocolProvider extends ScriptedProvider {
  readonly streams: NativeTerminal[] = [];
  readonly commands: string[][] = [];
  override async spawn(_handle: SandboxHandle, spec: ProcessSpec): Promise<ProcessStream> {
    this.commands.push(spec.cmd);
    if (spec.tty) {
      const stream = new NativeTerminal();
      this.streams.push(stream);
      return stream;
    }
    const output = spec.cmd.join(' ').includes('printf %s "$HOME"')
      ? '/root'
      : JSON.stringify(spec.cmd);
    return {
      ref: 'exec',
      onData: (cb) => cb(Buffer.from(output)),
      onExit: (cb) => cb(0),
      write: () => {},
      resize: () => {},
      detach: () => {},
      kill: async () => {},
    };
  }
  close() {
    for (const stream of this.streams) stream.child.kill();
  }
}

export function registryMetadataFixture(): ImageSpecRegistry {
  const provider: ImageSpecProvider = {
    name: 'local-metadata',
    resolve: async (ref) => {
      const parsed = parseImageRef(ref);
      const version = parsed.digest ?? parsed.tag ?? 'latest';
      return {
        ref: formatImageRef(parsed.name, version),
        digest: `sha256:${createHash('sha256').update(ref).digest('hex')}`,
        resolvedAt: '2026-10-05T00:00:00Z',
        entrypoint: ['/bin/sh'],
        manifest: {
          name: parsed.name,
          version,
          baseImage: parsed.name,
          entrypointContract: { workdir: '/', entrypoint: ['/bin/sh'] },
          supportedRuntimes: ['codex', 'claude-code'],
          resourceDefaults: { cores: 1, ramMb: 512, diskMb: 512 },
          labelsRequired: ['platform.tmux'],
          diffIds: [`sha256:${'b'.repeat(64)}`],
        },
      };
    },
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
  return {
    defaultProvider: provider.name,
    get: () => provider,
    has: (name) => name === provider.name,
    list: () => [provider],
    register: () => {
      throw new Error('fixture registry is fixed');
    },
  };
}
