import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  SandboxProvider,
  SandboxProviderContext,
  SandboxHandle,
  ProcessStream,
  SandboxFiles,
  SandboxJobs,
  JobChunk,
} from '@platform/contracts';

/** Only the external resource plane is controlled; RPC, lease, SQLite and bytes are real. */
export class CounterProcessProvider implements SandboxProvider {
  readonly name = 'counter-process';
  readonly capabilities = {
    spawnTty: false,
    volumeMount: true,
    updateResources: false,
    pauseResume: false,
    snapshot: false,
    watchEvents: false,
    headlessTask: true,
  };
  readonly instances = new Map<
    string,
    {
      state: 'instance_running' | 'instance_exited' | 'instance_creating';
      child?: ChildProcessWithoutNullStreams;
      output: Buffer[];
    }
  >();
  creates = 0;
  starts = 0;
  stops = 0;
  destroys = 0;
  jobsStarted = 0;
  readonly files: SandboxFiles;
  readonly jobs: SandboxJobs;
  constructor(home: string) {
    const file = (path: string): string => {
      const selected = resolve(home, '.' + path);
      if (!selected.startsWith(resolve(home) + '/'))
        throw new Error('Fixture path outside its owned directory');
      return selected;
    };
    this.files = {
      readFile: async (_h, p) => {
        try {
          return await readFile(file(p));
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
          throw error;
        }
      },
      openFileStream: async (_h, p) => {
        try {
          await readFile(file(p));
          return createReadStream(file(p));
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
          throw error;
        }
      },
      writeFile: async (_h, p, content) => {
        await mkdir(resolve(file(p), '..'), { recursive: true });
        await writeFile(file(p), content, { mode: 0o600 });
      },
      listFiles: async (_h, p) =>
        (await readdir(file(p))).map((name) => ({ path: name, kind: 'file' as const })),
    };
    this.jobs = {
      startJob: async (h, spec) => {
        this.jobsStarted++;
        const stream = await this.spawn(h, { ...spec, tty: false });
        return { provider: this.name, jobId: stream.ref };
      },
      readJob: async (h, _j, cursor) => {
        const box = this.box(h);
        const start = Number(cursor ?? '0');
        const result: JobChunk = {
          stdout: Buffer.concat(box.output.slice(start)).toString(),
          stderr: '',
          cursor: String(box.output.length),
          status: box.child?.exitCode === null ? 'running' : 'exited',
        };
        return result;
      },
      killJob: async (h) => {
        this.box(h).child?.kill('SIGTERM');
      },
      releaseJob: async () => {},
    };
  }
  async create(context: SandboxProviderContext): Promise<SandboxHandle> {
    this.creates++;
    const id = `resource-${context.sandboxId}`;
    this.instances.set(id, { state: 'instance_creating', output: [] });
    return {
      provider: this.name,
      providerSandboxId: id,
      providerState: { privateOpaque: 'retained' },
    };
  }
  async start(handle: SandboxHandle): Promise<void> {
    this.starts++;
    this.box(handle).state = 'instance_running';
  }
  async stop(handle: SandboxHandle): Promise<void> {
    this.stops++;
    this.box(handle).child?.kill('SIGTERM');
    this.box(handle).state = 'instance_exited';
  }
  async destroy(handle: SandboxHandle): Promise<void> {
    this.destroys++;
    await this.stop(handle);
    this.instances.delete(handle.providerSandboxId);
  }
  async inspect(handle: SandboxHandle) {
    return { lifecycleState: this.box(handle).state, raw: { pid: this.box(handle).child?.pid } };
  }
  async spawn(
    handle: SandboxHandle,
    _spec: { cmd: string[]; tty: boolean; reuse?: string },
  ): Promise<ProcessStream> {
    const box = this.box(handle);
    if (!box.child) {
      box.child = spawn(
        process.execPath,
        [
          '-e',
          "let n=0;setInterval(()=>process.stdout.write('SEQ '+(++n)+'\\n'),30);process.stdin.on('data',b=>process.stdout.write(b));",
        ],
        { stdio: 'pipe' },
      );
      box.child.stdout.on('data', (chunk: Buffer) => box.output.push(chunk));
    }
    const child = box.child;
    const data = new Set<(bytes: Buffer) => void>();
    const exit = new Set<(code: number | null) => void>();
    const output = (chunk: Buffer): void => {
      for (const cb of data) cb(chunk);
    };
    const ended = (code: number | null): void => {
      for (const cb of exit) cb(code);
    };
    child.stdout.on('data', output);
    child.once('exit', ended);
    return {
      ref: `process-${child.pid}`,
      onData: (cb) => data.add(cb),
      onExit: (cb) => exit.add(cb),
      write: (bytes) => {
        child.stdin.write(bytes);
      },
      resize: () => {},
      kill: async (signal) => {
        child.kill(signal);
      },
      detach: () => {
        child.stdout.off('data', output);
        child.off('exit', ended);
        data.clear();
        exit.clear();
      },
    };
  }
  private box(handle: SandboxHandle) {
    const box = this.instances.get(handle.providerSandboxId);
    if (!box) throw new Error('Missing controlled resource');
    return box;
  }
  async close(): Promise<void> {
    for (const box of this.instances.values())
      if (box.child && box.child.exitCode === null) {
        const child = box.child;
        await new Promise<void>((done) => {
          child.once('exit', () => done());
          child.kill('SIGTERM');
        });
      }
  }
}
