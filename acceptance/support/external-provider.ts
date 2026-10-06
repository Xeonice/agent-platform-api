import { Readable } from 'node:stream';
import type {
  FileEntry,
  JobChunk,
  JobHandle,
  JobSpec,
  ProcessSpec,
  ProcessStream,
  SandboxFiles,
  SandboxHandle,
  SandboxJobs,
  SandboxProvider,
  SandboxProviderContext,
} from '@platform/contracts';

/** Scripted external job boundary. SQLite remains the authority for task outcome. */
class ScriptedJob {
  private settle!: () => void;
  readonly completion = new Promise<void>((resolve) => {
    this.settle = resolve;
  });
  exitCode: number | undefined;
  finish(code?: number) {
    this.exitCode = code;
    this.settle();
  }
}
class ScriptedJobs implements SandboxJobs {
  readonly jobs = new Map<string, ScriptedJob>();
  readonly released: string[] = [];
  async startJob(_handle: SandboxHandle, _spec: JobSpec): Promise<JobHandle> {
    const jobId = `job-${this.jobs.size + 1}`;
    this.jobs.set(jobId, new ScriptedJob());
    return { provider: 'aio', jobId };
  }
  async readJob(_handle: SandboxHandle, job: JobHandle): Promise<JobChunk> {
    const state = this.jobs.get(job.jobId);
    if (!state) throw new Error(`unknown external job ${job.jobId}`);
    await state.completion;
    return {
      stdout: '',
      stderr: '',
      cursor: 'complete',
      status: 'exited',
      exitCode: state.exitCode,
    };
  }
  async killJob(_handle: SandboxHandle, job: JobHandle) {
    this.jobs.get(job.jobId)?.finish();
  }
  async releaseJob(_handle: SandboxHandle, job: JobHandle) {
    this.released.push(job.jobId);
  }
}
class ScriptedFiles implements SandboxFiles {
  readonly files = new Map<string, Buffer>();
  async readFile(_handle: SandboxHandle, path: string) {
    return this.files.get(path) ?? null;
  }
  async openFileStream(_handle: SandboxHandle, path: string) {
    const bytes = this.files.get(path);
    return bytes ? Readable.from(bytes) : null;
  }
  async writeFile(_handle: SandboxHandle, path: string, value: string | Buffer) {
    this.files.set(path, Buffer.from(value));
  }
  async listFiles(_handle: SandboxHandle, path: string): Promise<FileEntry[]> {
    return [...this.files]
      .filter(([key]) => key.startsWith(`${path}/`))
      .map(([key, bytes]) => ({
        path: key,
        kind: 'file',
        size: bytes.length,
        modifiedAt: '2026-10-05T00:00:00Z',
      }));
  }
}
export class ScriptedProvider implements SandboxProvider {
  readonly name = 'aio';
  readonly capabilities = {
    spawnTty: true,
    volumeMount: true,
    updateResources: false,
    pauseResume: false,
    snapshot: false,
    watchEvents: false,
    headlessTask: true,
  };
  readonly jobs = new ScriptedJobs();
  readonly files = new ScriptedFiles();
  readonly calls: string[] = [];
  lastContext?: SandboxProviderContext;
  async create(context: SandboxProviderContext): Promise<SandboxHandle> {
    this.calls.push('create');
    this.lastContext = context;
    return { provider: this.name, providerSandboxId: `instance-${context.sandboxId}` };
  }
  async start(_handle: SandboxHandle) {
    this.calls.push('start');
  }
  async stop(_handle: SandboxHandle) {
    this.calls.push('stop');
  }
  async destroy(_handle: SandboxHandle) {
    this.calls.push('destroy');
  }
  async inspect() {
    this.calls.push('inspect');
    return { lifecycleState: 'instance_running' as const };
  }
  async spawn(_handle: SandboxHandle, _spec: ProcessSpec): Promise<ProcessStream> {
    return {
      ref: 'one-shot',
      onData: () => {},
      onExit: (cb) => cb(0),
      write: () => {},
      resize: () => {},
      kill: async () => {},
      detach: () => {},
    };
  }
}
