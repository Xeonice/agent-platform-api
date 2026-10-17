import { createHash, randomBytes } from 'node:crypto';
import { request, type IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';
import type { Clock } from '@platform/shared-kernel';
import {
  RuntimeOwnerMetadataSchema,
  RuntimeOwnerLeaseSchema,
  RuntimeOwnerStreamFrameSchema,
  SandboxProviderError,
  SandboxProviderErrorCode,
  type RuntimeOwnerCall,
  type RuntimeOwnerFence,
  type RuntimeOwnerLease,
  type RuntimeOwnerMetadata,
  type RuntimeOwnerMethod,
  type RuntimeOwnerStreamFrame,
  type ProviderRegistry,
  type SandboxProvider,
  type SandboxHandle,
  type SandboxProviderContext,
  type ProcessSpec,
  type ProcessStream,
  type SandboxRuntimeStatus,
  type SandboxJobs,
  type SandboxFiles,
  type ResolvedImageSpec,
  type ResourceQuota,
  type ProviderEvent,
} from '@platform/contracts';
import { explicitRuntimeBusinessAuthority, runtimeBusinessAuthority } from './authority-context';
import { decodeOwnerValue, encodeOwnerValue, ownerRecord } from './wire-codec';

export interface RuntimeOwnerClientOptions {
  endpoint: string;
  instanceId: string;
  key: string;
  generation: number;
  clock: Clock;
  deferClaim?: boolean;
}
function unconfirmedTransport(cause: unknown): SandboxProviderError {
  return new SandboxProviderError(
    SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
    'Runtime operation result is not confirmed; look up the original intent',
    cause,
    true,
  );
}

interface RuntimeReference {
  ownerId: string;
  sandboxId: string;
}
function runtimeReference(handle: SandboxHandle): RuntimeReference {
  const value = handle.providerState?.runtimeOwner;
  const reference = ownerRecord(value);
  if (typeof reference.ownerId !== 'string' || typeof reference.sandboxId !== 'string')
    throw new Error('Runtime ownership is unconfirmed');
  return { ownerId: reference.ownerId, sandboxId: reference.sandboxId };
}

/** Shared connection per owner; only StateCoordinator has the required key. */
export class RuntimeOwnerConnection {
  readonly sessionId = randomBytes(20).toString('hex');
  metadata!: RuntimeOwnerMetadata;
  private lease!: RuntimeOwnerLease;
  private renewal?: NodeJS.Timeout;
  private readonly endpoint: URL;
  constructor(readonly options: RuntimeOwnerClientOptions) {
    this.endpoint = new URL(options.endpoint);
    if (
      this.endpoint.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(this.endpoint.hostname) ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash
    ) {
      throw new Error('RuntimeOwner endpoint must be a configured loopback HTTP origin');
    }
    if (
      options.key.length < 32 ||
      !Number.isSafeInteger(options.generation) ||
      options.generation < 1
    )
      throw new Error('RuntimeOwner coordinator authority is not configured');
  }
  async connect(): Promise<void> {
    this.metadata = RuntimeOwnerMetadataSchema.parse(await this.json('/runtime/metadata'));
    if (this.metadata.instanceId !== this.options.instanceId)
      throw new Error('RuntimeOwner belongs to another instance');
    if (this.options.deferClaim) {
      if (!this.metadata.lease)
        throw new Error('Prepared coordinator needs an existing business writer');
      this.lease = this.metadata.lease;
      return;
    }
    await this.activate(this.options.generation);
  }
  async activate(generation: number): Promise<void> {
    this.assertBusinessWriter(true);
    this.options.generation = generation;
    this.options.deferClaim = false;
    this.metadata = RuntimeOwnerMetadataSchema.parse(await this.json('/runtime/metadata'));
    this.lease = RuntimeOwnerLeaseSchema.parse(
      await this.json('/runtime/lease', 'POST', {
        instanceId: this.options.instanceId,
        holderId: 'state-coordinator',
        sessionId: this.sessionId,
        generation,
        expectedFence: this.metadata.lease?.fence ?? 0,
        ttlMs: 30000,
      }),
    );
    if (this.renewal) clearInterval(this.renewal);
    this.renewal = setInterval(() => {
      void this.renew().catch(() => {
        /* Expired authority rejects mutations; never stop the running owner. */
      });
    }, 10000);
    this.renewal.unref();
  }
  async release(): Promise<void> {
    await this.json('/runtime/lease/release', 'POST', {
      instanceId: this.options.instanceId,
      holderId: 'state-coordinator',
      sessionId: this.sessionId,
      generation: this.options.generation,
      fence: this.lease.fence,
    });
    if (this.renewal) clearInterval(this.renewal);
  }
  close(): void {
    if (this.renewal) clearInterval(this.renewal);
  }
  private async renew(): Promise<void> {
    this.assertBusinessWriter();
    this.lease = RuntimeOwnerLeaseSchema.parse(
      await this.json('/runtime/lease', 'POST', {
        instanceId: this.options.instanceId,
        holderId: 'state-coordinator',
        sessionId: this.sessionId,
        generation: this.options.generation,
        expectedFence: this.lease.fence,
        ttlMs: 30000,
      }),
    );
  }
  async call(
    provider: string,
    method: RuntimeOwnerMethod,
    args: unknown[],
    sandboxId?: string,
  ): Promise<unknown> {
    if (
      ![
        'inspect',
        'imageStaged',
        'watchEvents',
        'jobs.readJob',
        'files.readFile',
        'files.listFiles',
        'files.openFileStream',
        'stream.detach',
      ].includes(method)
    )
      this.assertBusinessWriter();
    const call = this.envelope(provider, method, args, sandboxId);
    if (
      method === 'jobs.startJob' ||
      method === 'create' ||
      (method === 'destroy' && explicitRuntimeBusinessAuthority())
    ) {
      const digest = createHash('sha256')
        .update(JSON.stringify(encodeOwnerValue({ provider, method, args, sandboxId })))
        .digest('hex');
      const original = await this.observeOperation(call.fence.operationId);
      if (original.state !== 'absent') {
        if (
          original.state === 'complete' &&
          original.digest === digest &&
          (original.result !== undefined ||
            (method === 'destroy' && Object.prototype.hasOwnProperty.call(original, 'result')))
        )
          return original.result;
        throw new SandboxProviderError(
          SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
          'Original runtime operation is unconfirmed; only its recorded result may be observed',
          undefined,
          false,
        );
      }
    }
    const response = ownerRecord(
      await this.json('/runtime/call', 'POST', { ...call, args: args.map(encodeOwnerValue) }),
    );
    return decodeOwnerValue(response.value);
  }
  private assertBusinessWriter(allowPreparation = false): void {
    if (this.options.deferClaim && !allowPreparation)
      throw new SandboxProviderError(
        SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        'Prepared coordinator has no runtime business authority',
        undefined,
        true,
      );
    if (
      process.env.PLATFORM_PROCESS_ROLE === 'coordinator' &&
      process.env.COORDINATOR_WRITER_FENCE_VALID !== 'true'
    )
      throw new SandboxProviderError(
        SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        'Coordinator business writer fence is not authoritative',
        undefined,
        true,
      );
  }
  async assignments(): Promise<{ sandboxId: string; state: string }[]> {
    const items = await this.json('/runtime/assignments');
    if (!Array.isArray(items)) throw new Error('Runtime assignment inventory is not confirmed');
    return items.map((item) => {
      const value = ownerRecord(item);
      if (typeof value.sandboxId !== 'string' || typeof value.state !== 'string')
        throw new Error('Invalid runtime assignment inventory');
      return { sandboxId: value.sandboxId, state: value.state };
    });
  }
  async observeOperation(operationId: string): Promise<{
    state: 'pending' | 'complete' | 'failed' | 'absent' | 'unknown';
    digest?: string;
    result?: unknown;
  }> {
    try {
      const value = ownerRecord(
        await this.json('/runtime/operations/' + encodeURIComponent(operationId)),
      );
      if (!['pending', 'complete', 'failed', 'absent', 'unknown'].includes(String(value.state)))
        return { state: 'unknown' };
      return {
        state: value.state as 'pending' | 'complete' | 'failed' | 'absent' | 'unknown',
        ...(typeof value.digest === 'string' ? { digest: value.digest } : {}),
        ...(value.result === null || value.result === undefined
          ? {}
          : { result: decodeOwnerValue(value.result) }),
      };
    } catch {
      return { state: 'unknown' };
    }
  }
  async file(
    provider: string,
    handle: SandboxHandle,
    path: string,
    sandboxId: string,
  ): Promise<NodeJS.ReadableStream | null> {
    return this.openFile(provider, handle, path, sandboxId);
  }
  async originalHandle(sandboxId: string): Promise<SandboxHandle | null> {
    const result = ownerRecord(
      await this.json('/runtime/original-handle/' + encodeURIComponent(sandboxId)),
    );
    if (result.handle === null) return null;
    const handle = ownerRecord(result.handle);
    if (typeof handle.provider !== 'string' || typeof handle.providerSandboxId !== 'string')
      throw new Error('Original handle is unconfirmed');
    return {
      provider: handle.provider,
      providerSandboxId: handle.providerSandboxId,
      providerState: {
        runtimeOwner: { ownerId: this.metadata.ownerId, sandboxId },
        original: handle.providerState ?? {},
      },
    };
  }
  private async openFile(
    provider: string,
    handle: SandboxHandle,
    path: string,
    sandboxId: string,
  ): Promise<NodeJS.ReadableStream | null> {
    const call = this.envelope(provider, 'files.openFileStream', [handle, path], sandboxId);
    const response = await this.http('/runtime/call', 'POST', {
      ...call,
      args: call.args.map(encodeOwnerValue),
    });
    if (response.statusCode === 404) {
      response.resume();
      return null;
    }
    if (response.statusCode !== 200) await this.raise(response);
    return response;
  }
  async *frames(
    streamId: string,
    signal: AbortSignal,
    onState?: (state: 'connected' | 'unconfirmed') => void,
  ): AsyncGenerator<RuntimeOwnerStreamFrame> {
    let seq = 0;
    let retries = 0;
    while (!signal.aborted) {
      try {
        const response = await this.http(
          `/runtime/streams/${encodeURIComponent(streamId)}?fromSeq=${seq}`,
          'GET',
          undefined,
          signal,
        );
        if (response.statusCode !== 200) await this.raise(response);
        onState?.('connected');
        let pending = '';
        for await (const item of response) {
          pending += (Buffer.isBuffer(item) ? item : Buffer.from(item as string)).toString('utf8');
          if (pending.length > 4 * 1024 * 1024)
            throw new Error('Runtime stream frame exceeds limit');
          let index: number;
          while ((index = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, index);
            pending = pending.slice(index + 1);
            if (!line) continue;
            const frame = RuntimeOwnerStreamFrameSchema.parse(JSON.parse(line) as unknown);
            if (frame.seq <= seq) continue;
            if (frame.type !== 'error' && frame.seq !== seq + 1)
              throw new Error('Runtime stream sequence is not continuous');
            seq = frame.seq;
            retries = 0;
            yield frame;
            if (frame.type === 'exit' || frame.type === 'error') return;
          }
        }
        if (pending) throw new Error('Truncated runtime stream frame');
        throw new Error('Runtime transport ended without a process exit');
      } catch (error) {
        if (signal.aborted) return;
        onState?.('unconfirmed');
        if (
          error instanceof SandboxProviderError &&
          error.code === SandboxProviderErrorCode.NOT_FOUND
        )
          throw error;
        if (++retries > 5) throw error;
        // Retry only observation of this same stream and cursor. Never replay input/spawn.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(1000, retries * 200));
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    }
  }
  private envelope(
    provider: string,
    method: RuntimeOwnerMethod,
    args: unknown[],
    sandboxId?: string,
  ): RuntimeOwnerCall {
    const authority = runtimeBusinessAuthority();
    const stable = explicitRuntimeBusinessAuthority();
    if (method === 'jobs.startJob' && !stable)
      throw new SandboxProviderError(
        SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        'Starting a job requires a persisted run intent',
      );
    const digest = createHash('sha256')
      .update(JSON.stringify(encodeOwnerValue({ provider, method, args, sandboxId })))
      .digest('hex');
    const operationId =
      method === 'jobs.startJob' && stable
        ? `job:${stable.operationId}:${digest}`
        : method === 'destroy' && stable
          ? `destroy:${stable.operationId}:${digest}`
          : method === 'create' && sandboxId && !sandboxId.startsWith('auth-helper')
            ? stable
              ? `create:${stable.operationId}`
              : `create:${sandboxId}:${digest}`
            : `rpc:${randomBytes(20).toString('hex')}`;
    const observe = [
      'inspect',
      'imageStaged',
      'watchEvents',
      'jobs.readJob',
      'files.readFile',
      'files.listFiles',
      'files.openFileStream',
      'stream.detach',
    ].includes(method);
    const fence: RuntimeOwnerFence = {
      ...this.lease,
      instanceId: this.options.instanceId,
      holderId: 'state-coordinator',
      operationId,
      sandboxId,
      actor: authority.actor,
      authority: observe ? 'observe' : 'business',
    };
    return { provider, method, args, fence };
  }
  private http(
    path: string,
    method = 'GET',
    data?: unknown,
    signal?: AbortSignal,
  ): Promise<IncomingMessage> {
    const body = data === undefined ? undefined : JSON.stringify(data);
    return new Promise((resolve, reject) => {
      const outgoing = request(
        new URL(path, this.endpoint),
        {
          method,
          signal,
          headers: {
            'x-platform-internal-key': this.options.key,
            'x-platform-instance-id': this.options.instanceId,
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
          },
        },
        resolve,
      );
      outgoing.setTimeout(
        method === 'GET' && path.startsWith('/runtime/streams/') ? 0 : 120000,
        () =>
          outgoing.destroy(unconfirmedTransport(new Error('RuntimeOwner HTTP response timeout'))),
      );
      outgoing.on('error', (error) =>
        reject(error instanceof SandboxProviderError ? error : unconfirmedTransport(error)),
      );
      outgoing.end(body);
    });
  }
  private async json(path: string, method = 'GET', data?: unknown): Promise<unknown> {
    const response = await this.http(path, method, data);
    if (response.statusCode !== 200) await this.raise(response);
    return JSON.parse(await this.text(response)) as unknown;
  }
  private async text(response: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const item of response) {
        const chunk = Buffer.isBuffer(item) ? item : Buffer.from(item as string);
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024)
          throw new Error('Runtime response exceeds control-message limit');
        chunks.push(chunk);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE'].includes(
          String(error.code),
        )
      )
        throw unconfirmedTransport(error);
      throw error;
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  private async raise(response: IncomingMessage): Promise<never> {
    let error: Record<string, unknown> = {};
    try {
      error = ownerRecord(ownerRecord(JSON.parse(await this.text(response)) as unknown).error);
    } catch {
      /* Never include raw upstream body in logs/errors. */
    }
    const code =
      typeof error.code === 'string' &&
      Object.values(SandboxProviderErrorCode).includes(error.code as SandboxProviderErrorCode)
        ? (error.code as SandboxProviderErrorCode)
        : SandboxProviderErrorCode.PROVIDER_UNAVAILABLE;
    throw new SandboxProviderError(
      code,
      typeof error.message === 'string' ? error.message : 'RuntimeOwner state is not confirmed',
      undefined,
      error.retryable === true,
    );
  }
}

export class RuntimeOwnerProcessStream implements ProcessStream {
  private readonly events = new EventEmitter();
  private readonly abort = new AbortController();
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private exit: { code: number | null } | undefined;
  private detached = false;
  readonly connectionErrors = new EventEmitter();
  private connectionState: 'connected' | 'unconfirmed' = 'unconfirmed';
  private connectionStateObserved = false;
  constructor(
    readonly ref: string,
    private readonly id: string,
    private readonly provider: string,
    private readonly connection: RuntimeOwnerConnection,
    private readonly sandboxId?: string,
    readonly runtimeIdentity: string | null = null,
  ) {
    void this.pump();
  }
  onData(cb: (chunk: Buffer) => void): void {
    this.events.on('data', cb);
    for (const chunk of this.pending) cb(chunk);
    this.pending = [];
    this.pendingBytes = 0;
  }
  onExit(cb: (code: number | null) => void): void {
    this.events.on('exit', cb);
    if (this.exit) cb(this.exit.code);
  }
  onConnectionState(cb: (state: 'connected' | 'unconfirmed') => void): void {
    this.events.on('connection', cb);
    if (this.connectionStateObserved) cb(this.connectionState);
  }
  write(data: string | Buffer): void {
    if (!this.detached)
      void this.connection
        .call(this.provider, 'stream.write', [this.id, data], this.sandboxId)
        .catch((error) => this.unconfirmed(error));
  }
  resize(cols: number, rows: number): void {
    if (!this.detached)
      void this.connection
        .call(this.provider, 'stream.resize', [this.id, cols, rows], this.sandboxId)
        .catch((error) => this.unconfirmed(error));
  }
  async kill(signal?: NodeJS.Signals): Promise<void> {
    await this.connection.call(this.provider, 'stream.kill', [this.id, signal], this.sandboxId);
  }
  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.abort.abort();
    this.events.removeAllListeners();
    this.pending = [];
    this.pendingBytes = 0;
    void this.connection
      .call(this.provider, 'stream.detach', [this.id], this.sandboxId)
      .catch(() => {
        /* Detach failure must never be escalated to kill. */
      });
  }
  private async pump(): Promise<void> {
    try {
      for await (const frame of this.connection.frames(this.id, this.abort.signal, (state) => {
        this.observeConnectionState(state);
      })) {
        if (frame.type === 'data') {
          const data = Buffer.from(frame.data, 'base64');
          if (this.events.listenerCount('data')) this.events.emit('data', data);
          else {
            this.pendingBytes += data.length;
            if (this.pendingBytes > 2 * 1024 * 1024)
              throw new Error('Unobserved runtime output exceeded cursor retention');
            this.pending.push(data);
          }
        } else if (frame.type === 'exit') {
          this.exit = { code: frame.code };
          this.events.emit('exit', frame.code);
        } else if (frame.type === 'error') throw new Error(frame.code);
      }
    } catch (error) {
      // Connection loss is not a guest process exit. The gateway can expose unknown.
      if (!this.detached) this.unconfirmed(error);
    }
  }
  private unconfirmed(error: unknown): void {
    this.observeConnectionState('unconfirmed');
    this.connectionErrors.emit('unconfirmed', error);
  }
  private observeConnectionState(state: 'connected' | 'unconfirmed'): void {
    // The constructor's initial value is not a failed read. Only replay actual
    // HTTP observation, including a first failure before any successful read.
    const changed = !this.connectionStateObserved || this.connectionState !== state;
    this.connectionStateObserved = true;
    this.connectionState = state;
    if (changed) this.events.emit('connection', state);
  }
}

/** SPI proxy preserves opaque original handles and routes old resources to their owner. */
export class RuntimeOwnerProvider implements SandboxProvider {
  readonly name: string;
  readonly capabilities: SandboxProvider['capabilities'];
  readonly jobs?: SandboxJobs;
  readonly files?: SandboxFiles;
  readonly imageStaged?: (image: ResolvedImageSpec) => Promise<boolean>;
  readonly stageImage?: (
    image: ResolvedImageSpec,
    progress?: (bytes: number) => void,
  ) => Promise<void>;
  readonly destroyBySandboxId?: (sandboxId: string) => Promise<void>;
  readonly updateResources?: (handle: SandboxHandle, quota: ResourceQuota) => Promise<void>;
  readonly watchEvents?: () => AsyncIterable<ProviderEvent>;
  constructor(
    descriptor: RuntimeOwnerMetadata['providers'][number],
    private readonly registry: RuntimeOwnerProviderRegistry,
  ) {
    this.name = descriptor.name;
    this.capabilities = descriptor.capabilities;
    if (descriptor.methods.includes('jobs.startJob'))
      this.jobs = {
        startJob: async (h, spec) =>
          (await this.call(h, 'jobs.startJob', [spec])) as Awaited<
            ReturnType<SandboxJobs['startJob']>
          >,
        readJob: async (h, job, cursor, opts) =>
          (await this.call(h, 'jobs.readJob', [job, cursor, opts])) as Awaited<
            ReturnType<SandboxJobs['readJob']>
          >,
        killJob: async (h, job, signal) => {
          await this.call(h, 'jobs.killJob', [job, signal]);
        },
        releaseJob: async (h, job) => {
          await this.call(h, 'jobs.releaseJob', [job]);
        },
      };
    if (descriptor.methods.includes('files.readFile'))
      this.files = {
        readFile: async (h, path) =>
          (await this.call(h, 'files.readFile', [path])) as Buffer | null,
        openFileStream: async (h, path) => {
          const ref = runtimeReference(h);
          return this.registry.connection(ref.ownerId).file(this.name, h, path, ref.sandboxId);
        },
        writeFile: async (h, path, content) => {
          await this.call(h, 'files.writeFile', [path, content]);
        },
        listFiles: async (h, path, opts) =>
          (await this.call(h, 'files.listFiles', [path, opts])) as Awaited<
            ReturnType<SandboxFiles['listFiles']>
          >,
      };
    if (descriptor.methods.includes('imageStaged'))
      this.imageStaged = async (image) =>
        (await this.registry.active.call(this.name, 'imageStaged', [image])) as boolean;
    if (descriptor.methods.includes('stageImage'))
      this.stageImage = async (image, progress) => {
        const connection = this.registry.active;
        const result = ownerRecord(await connection.call(this.name, 'stageImage', [image]));
        const signal = new AbortController();
        try {
          for await (const frame of connection.frames(String(result.streamId), signal.signal)) {
            if (frame.type === 'progress') progress?.(frame.bytes);
            if (frame.type === 'error' || (frame.type === 'exit' && frame.code !== 0))
              throw new SandboxProviderError(
                SandboxProviderErrorCode.IMAGE_PULL_FAILED,
                'Image staging did not complete',
              );
          }
        } finally {
          signal.abort();
          await connection.call(this.name, 'stream.detach', [String(result.streamId)]);
        }
      };
    if (descriptor.methods.includes('destroyBySandboxId'))
      this.destroyBySandboxId = async (id) => {
        const connection = this.registry.assignedOwner(id) ?? this.registry.active;
        await connection.call(this.name, 'destroyBySandboxId', [id], id);
      };
    if (descriptor.methods.includes('updateResources'))
      this.updateResources = async (h, q) => {
        await this.call(h, 'updateResources', [q]);
      };
    if (descriptor.methods.includes('watchEvents')) this.watchEvents = () => this.providerEvents();
  }
  async create(context: SandboxProviderContext): Promise<SandboxHandle> {
    const connection = this.registry.assignedOwner(context.sandboxId) ?? this.registry.active;
    this.registry.noteAssignment(context.sandboxId, connection.metadata.ownerId);
    const handle = (await connection.call(
      this.name,
      'create',
      [context],
      context.sandboxId,
    )) as SandboxHandle;
    this.registry.noteAssignment(context.sandboxId, connection.metadata.ownerId);
    return {
      ...handle,
      providerState: {
        runtimeOwner: { ownerId: connection.metadata.ownerId, sandboxId: context.sandboxId },
        original: handle.providerState ?? {},
      },
    };
  }
  async observeOperation(
    sandboxId: string,
    operationId: string,
  ): Promise<{
    state: 'pending' | 'complete' | 'failed' | 'absent' | 'unknown';
    result?: unknown;
  }> {
    const connection = this.registry.assignedOwner(sandboxId);
    if (!connection) return { state: 'unknown' };
    const observation = await connection.observeOperation('create:' + operationId);
    if (observation.state !== 'complete') return observation;
    const handle = ownerRecord(observation.result);
    if (handle.provider !== this.name || typeof handle.providerSandboxId !== 'string')
      return { state: 'unknown' };
    return {
      ...observation,
      result: {
        ...handle,
        providerState: {
          runtimeOwner: { ownerId: connection.metadata.ownerId, sandboxId },
          original: handle.providerState ?? {},
        },
      },
    };
  }
  async start(handle: SandboxHandle): Promise<void> {
    await this.call(handle, 'start', []);
  }
  async originalHandle(sandboxId: string): Promise<SandboxHandle | null> {
    const owner = this.registry.assignedOwner(sandboxId);
    if (!owner) return null;
    const handle = await owner.originalHandle(sandboxId);
    if (handle && handle.provider !== this.name)
      throw new SandboxProviderError(
        SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        'Original helper belongs to another provider',
        undefined,
        true,
      );
    return handle;
  }
  async stop(handle: SandboxHandle, opts?: { timeoutSec?: number }): Promise<void> {
    await this.call(handle, 'stop', [opts]);
  }
  async destroy(handle: SandboxHandle): Promise<void> {
    await this.call(handle, 'destroy', []);
  }
  async inspect(handle: SandboxHandle): Promise<SandboxRuntimeStatus> {
    return (await this.call(handle, 'inspect', [])) as SandboxRuntimeStatus;
  }
  async spawn(handle: SandboxHandle, spec: ProcessSpec): Promise<ProcessStream> {
    const reference = runtimeReference(handle);
    const connection = this.registry.connection(reference.ownerId);
    const result = ownerRecord(
      await connection.call(this.name, 'spawn', [handle, spec], reference.sandboxId),
    );
    if (typeof result.ref !== 'string' || typeof result.streamId !== 'string')
      throw new Error('Runtime stream identity is not confirmed');
    return new RuntimeOwnerProcessStream(
      result.ref,
      result.streamId,
      this.name,
      connection,
      reference.sandboxId,
      typeof result.runtimeIdentity === 'string' ? result.runtimeIdentity : null,
    );
  }
  private call(
    handle: SandboxHandle,
    method: RuntimeOwnerMethod,
    args: unknown[],
  ): Promise<unknown> {
    const reference = runtimeReference(handle);
    return this.registry
      .connection(reference.ownerId)
      .call(this.name, method, [handle, ...args], reference.sandboxId);
  }
  private async *providerEvents(): AsyncGenerator<ProviderEvent> {
    const connection = this.registry.active;
    const result = ownerRecord(await connection.call(this.name, 'watchEvents', []));
    const abort = new AbortController();
    try {
      for await (const frame of connection.frames(String(result.streamId), abort.signal)) {
        if (frame.type === 'provider-event') yield frame.event;
        if (frame.type === 'error') throw new Error(frame.code);
      }
    } finally {
      abort.abort();
      await connection.call(this.name, 'stream.detach', [String(result.streamId)]);
    }
  }
}

export class RuntimeOwnerProviderRegistry implements ProviderRegistry {
  private readonly owners = new Map<string, RuntimeOwnerConnection>();
  private readonly providers = new Map<string, SandboxProvider>();
  private readonly assignments = new Map<string, string>();
  private activeId = '';
  get active(): RuntimeOwnerConnection {
    return this.connection(this.activeId);
  }
  get defaultProvider(): string {
    return this.active.metadata.defaultProvider;
  }
  get activeOwnerId(): string {
    return this.activeId;
  }
  installedRoutes(): {
    ownerId: string;
    endpoint: string;
    artifactDigest?: string;
    inputFingerprint?: string;
  }[] {
    return [...this.owners.values()].map((owner) => ({
      ownerId: owner.metadata.ownerId,
      endpoint: owner.options.endpoint,
      ...(owner.metadata.artifactDigest ? { artifactDigest: owner.metadata.artifactDigest } : {}),
      ...(owner.metadata.inputFingerprint
        ? { inputFingerprint: owner.metadata.inputFingerprint }
        : {}),
    }));
  }
  async addOwner(options: RuntimeOwnerClientOptions, active = false): Promise<void> {
    const connection = new RuntimeOwnerConnection(options);
    await connection.connect();
    const id = connection.metadata.ownerId;
    if (this.owners.has(id)) {
      connection.close();
      throw new Error('RuntimeOwner is already registered');
    }
    this.owners.set(id, connection);
    if (active || !this.activeId) this.activeId = id;
    for (const descriptor of connection.metadata.providers)
      if (!this.providers.has(descriptor.name))
        this.providers.set(descriptor.name, new RuntimeOwnerProvider(descriptor, this));
    for (const assignment of await connection.assignments())
      if (assignment.state === 'owned' || assignment.state === 'unconfirmed') {
        const existing = this.assignments.get(assignment.sandboxId);
        if (existing && existing !== id)
          throw new Error('Runtime assignment is claimed by two owners');
        this.assignments.set(assignment.sandboxId, id);
      }
  }
  activateOwner(ownerId: string): void {
    this.connection(ownerId);
    this.activeId = ownerId;
  }
  async activateBusinessAuthority(generation: number): Promise<void> {
    for (const owner of this.owners.values()) await owner.activate(generation);
  }
  async releaseBusinessAuthority(): Promise<void> {
    for (const owner of this.owners.values()) await owner.release();
  }
  connection(ownerId: string): RuntimeOwnerConnection {
    const owner = this.owners.get(ownerId);
    if (!owner)
      throw new SandboxProviderError(
        SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        'Original RuntimeOwner is not confirmed',
        undefined,
        true,
      );
    return owner;
  }
  assignedOwner(sandboxId: string): RuntimeOwnerConnection | undefined {
    const id = this.assignments.get(sandboxId);
    return id ? this.connection(id) : undefined;
  }
  noteAssignment(sandboxId: string, ownerId: string): void {
    this.assignments.set(sandboxId, ownerId);
  }
  register(provider: SandboxProvider): void {
    if (this.providers.has(provider.name)) throw new Error('Duplicate remote provider');
    throw new Error('Providers must be installed in an authenticated RuntimeOwner');
  }
  get(name: string): SandboxProvider {
    const provider = this.providers.get(name);
    if (!provider)
      throw new SandboxProviderError(
        SandboxProviderErrorCode.NOT_FOUND,
        'Provider is not registered in RuntimeOwner',
      );
    return provider;
  }
  has(name: string): boolean {
    return this.providers.has(name);
  }
  list(): SandboxProvider[] {
    return [...this.providers.values()];
  }
  onModuleDestroy(): void {
    for (const owner of this.owners.values()) owner.close();
  }
}
