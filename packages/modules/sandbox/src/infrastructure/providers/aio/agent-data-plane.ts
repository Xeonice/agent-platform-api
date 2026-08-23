import type {
  FileEntry,
  JobChunk,
  JobCursor,
  JobHandle,
  JobReadOptions,
  JobSpec,
  SandboxFiles,
  SandboxHandle,
  SandboxJobs,
} from '@platform/contracts';
import { SandboxProviderError, SandboxProviderErrorCode } from '@platform/contracts';
import type { AioSandboxAgentClient } from './aio-sandbox-agent.client';

/**
 * The two optional planes of 04 §2.6, expressed ONCE over the shared in-sandbox agent
 * client.
 *
 * WHY THEY LIVE HERE RATHER THAN IN EACH PROVIDER: `aio` and `boxlite` run the SAME
 * image and therefore the same agent — `boxlite` just reaches it through a forwarded
 * host loopback port instead of a published container port (04 §2.2 「同左」). The
 * only thing that differs is how a `SandboxHandle` becomes an agent origin, so that
 * is the single injected function; everything else is shared by construction. Two
 * copies would be two chances for the providers to drift on the ordering rule in
 * `startJob`, which is exactly the failure mode that only shows up after a restart.
 *
 * The classes are GROUPED per the contract (`jobs` / `files` are objects, not seven
 * flat optional methods) so "a provider implements all of a plane or none of it" is
 * structural rather than conventional (04 §2.6 裁决 5).
 */
export type AgentClientFor = (handle: SandboxHandle) => Promise<AioSandboxAgentClient>;

/** Guard the handle really belongs to this provider before touching the data plane. */
function assertOwned(providerName: string, handle: SandboxHandle, job?: JobHandle): void {
  if (handle.provider !== providerName) {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.INVALID_STATE,
      `sandbox handle belongs to provider '${handle.provider}', not '${providerName}'`,
    );
  }
  if (job && job.provider !== providerName) {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.INVALID_STATE,
      `job handle belongs to provider '${job.provider}', not '${providerName}'`,
    );
  }
}

export class AgentSandboxJobs implements SandboxJobs {
  constructor(
    private readonly providerName: string,
    private readonly clientFor: AgentClientFor,
  ) {}

  async startJob(handle: SandboxHandle, spec: JobSpec): Promise<JobHandle> {
    assertOwned(this.providerName, handle);
    const client = await this.clientFor(handle);
    const jobId = await client.startJob(spec);
    // pure data, no live object: the whole handle round-trips through the database,
    // which is what "a platform restart does not lose a running Task" rests on.
    return { provider: this.providerName, jobId };
  }

  async readJob(
    handle: SandboxHandle,
    job: JobHandle,
    cursor?: JobCursor,
    opts?: JobReadOptions,
  ): Promise<JobChunk> {
    assertOwned(this.providerName, handle, job);
    const client = await this.clientFor(handle);
    return client.readJob(job.jobId, cursor, opts?.waitMs);
  }

  async killJob(handle: SandboxHandle, job: JobHandle, signal?: NodeJS.Signals): Promise<void> {
    assertOwned(this.providerName, handle, job);
    const client = await this.clientFor(handle);
    await client.killJob(job.jobId, signal);
  }

  async releaseJob(handle: SandboxHandle, job: JobHandle): Promise<void> {
    assertOwned(this.providerName, handle, job);
    const client = await this.clientFor(handle);
    await client.releaseJob(job.jobId);
  }
}

export class AgentSandboxFiles implements SandboxFiles {
  constructor(
    private readonly providerName: string,
    private readonly clientFor: AgentClientFor,
  ) {}

  async readFile(handle: SandboxHandle, path: string): Promise<Buffer | null> {
    assertOwned(this.providerName, handle);
    const client = await this.clientFor(handle);
    return client.readFileBytes(path);
  }

  async openFileStream(handle: SandboxHandle, path: string): Promise<NodeJS.ReadableStream | null> {
    assertOwned(this.providerName, handle);
    const client = await this.clientFor(handle);
    return client.openFileStream(path);
  }

  async writeFile(handle: SandboxHandle, path: string, content: string | Buffer): Promise<void> {
    assertOwned(this.providerName, handle);
    const client = await this.clientFor(handle);
    await client.writeFileContent(path, content);
  }

  async listFiles(
    handle: SandboxHandle,
    path: string,
    opts?: { recursive?: boolean; maxEntries?: number },
  ): Promise<FileEntry[]> {
    assertOwned(this.providerName, handle);
    const client = await this.clientFor(handle);
    return client.listFiles(path, opts);
  }
}
