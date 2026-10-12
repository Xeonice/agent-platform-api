import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { Clock } from '@platform/shared-kernel';
import {
  RuntimeOwnerCallSchema,
  RuntimeOwnerLeaseClaimSchema,
  RuntimeOwnerLeaseReleaseSchema,
  RuntimeOwnerContextSchema,
  SandboxProviderError,
  SandboxProviderErrorCode,
  type RuntimeOwnerCall,
  type RuntimeOwnerMetadata,
  type RuntimeOwnerMethod,
  type RuntimeOwnerStreamFrame,
  type SandboxHandle,
  type SandboxProvider,
  type ProviderRegistry,
  type ProcessStream,
  type ProcessSpec,
  type SandboxProviderContext,
  type ResourceQuota,
  type ResolvedImageSpec,
  type JobSpec,
  type JobHandle,
  type JobReadOptions,
} from '@platform/contracts';
import { RuntimeOwnerJournal } from './owner-journal';
import { decodeOwnerValue, encodeOwnerValue, ownerRecord } from './wire-codec';
import { runtimeStartIdentity } from './runtime-identity';

const READ_ONLY = new Set<RuntimeOwnerMethod>([
  'inspect',
  'imageStaged',
  'watchEvents',
  'jobs.readJob',
  'files.readFile',
  'files.listFiles',
  'files.openFileStream',
  'stream.detach',
]);
const BODY_LIMIT = 24 * 1024 * 1024;
const STREAM_LIMIT = 2 * 1024 * 1024;
interface OwnerStream {
  id: string;
  provider: string;
  sandboxId?: string;
  native?: ProcessStream;
  frames: RuntimeOwnerStreamFrame[];
  bytes: number;
  seq: number;
  ended: boolean;
  endedAt?: number;
  blockingEffect?: boolean;
  dispose?: () => void;
  observers: Set<ServerResponse>;
}
export interface RuntimeOwnerServerOptions {
  instanceId: string;
  ownerId: string;
  key: string;
  journalPath: string;
  registry: ProviderRegistry;
  clock: Clock;
  artifactIdentity?: { artifactDigest: string; inputFingerprint: string } | null;
  startIdentity?: string;
}

/** Stable SDK/PTY owner. HTTP and browser lifetimes never own sandbox lifetimes. */
export class RuntimeOwnerServer {
  readonly journal: RuntimeOwnerJournal;
  readonly server: Server;
  private readonly streams = new Map<string, OwnerStream>();
  private readonly activeOperations = new Map<string, Promise<unknown>>();
  private readonly effectTargets = new Map<
    string,
    { sandboxId?: string; method: RuntimeOwnerMethod }
  >();
  constructor(private readonly options: RuntimeOwnerServerOptions) {
    if (options.key.length < 32)
      throw new Error('RuntimeOwner requires a separate coordinator key of at least 32 characters');
    this.journal = new RuntimeOwnerJournal(
      options.journalPath,
      options.instanceId,
      options.ownerId,
      options.clock,
    );
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => this.failure(response, error));
    });
    this.server.requestTimeout = 120000;
    this.server.headersTimeout = 10000;
  }

  async listen(port: number, host = '127.0.0.1'): Promise<void> {
    if (!['127.0.0.1', '::1'].includes(host))
      throw new Error('RuntimeOwner RPC must bind loopback');
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, resolve);
    });
  }

  async close(): Promise<void> {
    // Detach only transport attachments. Do not stop SDK, VM, jobs or tmux sessions.
    for (const stream of this.streams.values()) {
      for (const observer of stream.observers) observer.end();
      stream.native?.detach();
      stream.dispose?.();
    }
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
    this.journal.close();
  }

  metadata(): RuntimeOwnerMetadata {
    return {
      protocol: 1,
      instanceId: this.options.instanceId,
      ownerId: this.options.ownerId,
      pid: process.pid,
      startIdentity: this.options.startIdentity ?? null,
      artifactDigest: this.options.artifactIdentity?.artifactDigest ?? null,
      inputFingerprint: this.options.artifactIdentity?.inputFingerprint ?? null,
      lease: this.journal.lease(),
      defaultProvider: this.options.registry.defaultProvider,
      providers: this.options.registry.list().map((provider) => ({
        name: provider.name,
        capabilities: provider.capabilities,
        methods: [
          'create',
          'start',
          'stop',
          'destroy',
          'inspect',
          'spawn',
          ...(provider.updateResources ? ['updateResources' as const] : []),
          ...(provider.imageStaged ? ['imageStaged' as const] : []),
          ...(provider.stageImage ? ['stageImage' as const] : []),
          ...(provider.destroyBySandboxId ? ['destroyBySandboxId' as const] : []),
          ...(provider.watchEvents ? ['watchEvents' as const] : []),
          ...(provider.jobs
            ? (['jobs.startJob', 'jobs.readJob', 'jobs.killJob', 'jobs.releaseJob'] as const)
            : []),
          ...(provider.files
            ? ([
                'files.readFile',
                'files.writeFile',
                'files.listFiles',
                'files.openFileStream',
              ] as const)
            : []),
          'stream.write',
          'stream.resize',
          'stream.kill',
          'stream.detach',
        ],
      })),
    };
  }

  private authenticated(request: IncomingMessage): boolean {
    const supplied = request.headers['x-platform-internal-key'];
    const instance = request.headers['x-platform-instance-id'];
    if (typeof supplied !== 'string' || instance !== this.options.instanceId) return false;
    const actual = Buffer.from(supplied);
    const expected = Buffer.from(this.options.key);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!this.authenticated(request)) {
      this.json(response, 403, {
        error: { code: 'RUNTIME_AUTH_REQUIRED', message: 'RuntimeOwner authorization is required' },
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/runtime/continuity') {
      this.json(response, 200, this.journal.continuity());
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/runtime/original-handle/')) {
      const id = decodeURIComponent(url.pathname.slice('/runtime/original-handle/'.length));
      const owned = this.journal.assignmentBySandbox(id);
      const pending = this.journal
        .assignments()
        .find((item) => item.sandboxId === id && item.state === 'unconfirmed');
      if (pending)
        throw new SandboxProviderError(
          SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
          'Original runtime assignment is unconfirmed',
          undefined,
          true,
        );
      this.json(response, 200, {
        handle: owned?.state === 'owned' ? JSON.parse(owned.handle) : null,
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/runtime/metadata') {
      this.json(response, 200, this.metadata());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/runtime/assignments') {
      this.json(response, 200, this.journal.assignments());
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/runtime/operations/')) {
      const record = this.journal.operation(
        decodeURIComponent(url.pathname.slice('/runtime/operations/'.length)),
      );
      if (!record) {
        this.json(response, 200, { state: 'absent' });
        return;
      }
      this.json(response, 200, {
        state: record.state,
        digest: record.digest,
        result: record.result === null ? null : (JSON.parse(record.result) as unknown),
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/runtime/lease') {
      const claim = RuntimeOwnerLeaseClaimSchema.parse(await this.body(request));
      if (this.activeOperations.size && this.journal.lease()?.sessionId !== claim.sessionId) {
        throw new SandboxProviderError(
          SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
          'An owner effect is still being reconciled; writer handoff is deferred',
          undefined,
          true,
        );
      }
      this.json(response, 200, this.journal.claim(claim));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/runtime/lease/release') {
      const claim = RuntimeOwnerLeaseReleaseSchema.parse(await this.body(request));
      if (
        this.activeOperations.size ||
        [...this.streams.values()].some((stream) => stream.blockingEffect && !stream.ended)
      )
        throw new SandboxProviderError(
          SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
          'Owner effects are still in flight; coordinator handoff is deferred',
          undefined,
          true,
        );
      this.journal.release(claim);
      this.json(response, 200, { released: true });
      return;
    }
    const match = /^\/runtime\/streams\/([a-f0-9]{40})$/.exec(url.pathname);
    if (request.method === 'GET' && match) {
      const stream = this.streams.get(match[1]);
      if (!stream)
        throw new SandboxProviderError(
          SandboxProviderErrorCode.NOT_FOUND,
          'Runtime stream is not confirmed',
        );
      const cursor = Number(url.searchParams.get('fromSeq') ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > stream.seq)
        throw new Error('Invalid runtime stream cursor');
      response.writeHead(200, {
        'content-type': 'application/x-ndjson',
        'cache-control': 'no-store',
        'x-runtime-process-ref': encodeURIComponent(stream.native?.ref ?? stream.id),
      });
      response.flushHeaders();
      if (stream.frames[0] && stream.frames[0].seq > cursor + 1) {
        response.end(
          JSON.stringify({ type: 'error', seq: stream.seq + 1, code: 'STREAM_CURSOR_EXPIRED' }) +
            '\n',
        );
        return;
      }
      for (const frame of stream.frames)
        if (frame.seq > cursor) response.write(JSON.stringify(frame) + '\n');
      if (stream.ended) {
        response.end();
        return;
      }
      stream.observers.add(response);
      response.on('close', () => stream.observers.delete(response));
      // A disconnected reader is not a stop/cancel intent. Retain the native owner.
      return;
    }
    if (request.method === 'POST' && url.pathname === '/runtime/call') {
      const input = RuntimeOwnerCallSchema.parse(await this.body(request));
      const call: RuntimeOwnerCall = { ...input, args: input.args.map(decodeOwnerValue) };
      if (call.fence.instanceId !== this.options.instanceId)
        throw new Error('Runtime instance mismatch');
      if (call.method === 'files.openFileStream') {
        this.journal.validate(call.fence, false);
        const provider = this.provider(call);
        if (!provider.files) this.unsupported();
        await this.requireRunning(provider, this.handleFor(call), call.fence.sandboxId);
        const stream = await provider.files.openFileStream(
          this.handleFor(call),
          this.string(call.args[1]),
        );
        if (!stream) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store',
        });
        await pipeline(stream as NodeJS.ReadableStream, response);
        return;
      }
      const value = await this.call(call);
      this.json(response, 200, { value: encodeOwnerValue(value) });
      return;
    }
    this.json(response, 404, {
      error: { code: 'NOT_FOUND', message: 'Runtime endpoint not found' },
    });
  }

  private async call(call: RuntimeOwnerCall): Promise<unknown> {
    const mutation = !READ_ONLY.has(call.method);
    this.journal.validate(call.fence, mutation);
    if (!mutation) return this.invoke(call);
    const active = this.activeOperations.get(call.fence.operationId);
    if (active) {
      // Validate the input digest through the journal before sharing an in-flight result.
      const previous = this.journal.operation(call.fence.operationId);
      const probe = { ...call, args: call.args };
      if (!previous) throw new Error('Missing runtime intent');
      const { createHash } = await import('node:crypto');
      const digest = createHash('sha256')
        .update(
          JSON.stringify(
            encodeOwnerValue({
              provider: probe.provider,
              method: probe.method,
              args: probe.args,
              sandboxId: probe.fence.sandboxId,
            }),
          ),
        )
        .digest('hex');
      if (previous.digest !== digest)
        throw new Error('Operation identity reused with different input');
      return active;
    }
    const prior = this.journal.begin(call);
    if (prior.cached) return prior.value;
    this.effectTargets.set(call.fence.operationId, {
      sandboxId: call.fence.sandboxId,
      method: call.method,
    });
    const work = this.apply(call);
    this.activeOperations.set(call.fence.operationId, work);
    try {
      return await work;
    } finally {
      this.activeOperations.delete(call.fence.operationId);
      this.effectTargets.delete(call.fence.operationId);
    }
  }

  private async apply(call: RuntimeOwnerCall): Promise<unknown> {
    try {
      const value = await this.invoke(call);
      const assignment =
        call.method === 'create'
          ? {
              sandboxId: (call.args[0] as SandboxProviderContext).sandboxId,
              handle: value as SandboxHandle,
            }
          : undefined;
      let destroyed: string | undefined;
      if (call.method === 'destroy') {
        const handle = this.handleFor(call);
        destroyed = this.journal
          .assignments()
          .find(
            (item) =>
              item.provider === handle.provider &&
              item.providerSandboxId === handle.providerSandboxId,
          )?.sandboxId;
      } else if (call.method === 'destroyBySandboxId') destroyed = this.string(call.args[0]);
      this.journal.complete(call, value, assignment, destroyed);
      return value;
    } catch (error) {
      // Unknown or failed side effects are retained. A retry never blindly replays them.
      this.journal.fail(call.fence.operationId);
      throw error;
    }
  }

  private async invoke(call: RuntimeOwnerCall): Promise<unknown> {
    const provider = this.provider(call);
    const a = call.args;
    if (call.method === 'create') {
      const context = RuntimeOwnerContextSchema.parse(a[0]);
      if (typeof context.sandboxId !== 'string' || context.sandboxId !== call.fence.sandboxId)
        throw new Error('Create assignment mismatch');
      const existing = this.journal.assignmentBySandbox(context.sandboxId);
      if (existing?.state === 'owned') throw new Error('Sandbox already has a runtime owner');
      return provider.create(context);
    }
    if (call.method === 'imageStaged') {
      if (!provider.imageStaged) this.unsupported();
      return provider.imageStaged(a[0] as ResolvedImageSpec);
    }
    if (call.method === 'watchEvents') {
      if (!provider.watchEvents) this.unsupported();
      const events = this.newStream(provider.name);
      const source = provider.watchEvents()[Symbol.asyncIterator]();
      events.dispose = () => {
        void source.return?.();
      };
      void (async () => {
        try {
          while (!events.ended) {
            const item = await source.next();
            if (item.done) break;
            this.emit(events, { type: 'provider-event', event: item.value });
          }
          this.emit(events, { type: 'exit', code: 0 });
        } catch {
          this.emit(events, { type: 'error', code: 'PROVIDER_UNAVAILABLE' });
        }
      })();
      return { streamId: events.id, ref: events.id };
    }
    if (call.method === 'stageImage') {
      if (!provider.stageImage) this.unsupported();
      const progress = this.newStream(provider.name);
      progress.blockingEffect = true;
      void provider
        .stageImage(a[0] as ResolvedImageSpec, (bytes) =>
          this.emit(progress, { type: 'progress', bytes }),
        )
        .then(
          () => this.emit(progress, { type: 'exit', code: 0 }),
          () => this.emit(progress, { type: 'error', code: 'IMAGE_PULL_FAILED' }),
        );
      return { streamId: progress.id, ref: progress.id };
    }
    if (call.method === 'destroyBySandboxId') {
      if (!provider.destroyBySandboxId) this.unsupported();
      const id = this.string(a[0]);
      if (!this.journal.assignmentBySandbox(id))
        throw new Error('No confirmed runtime assignment for cleanup');
      return provider.destroyBySandboxId(id);
    }
    if (call.method.startsWith('stream.')) {
      const stream = this.streams.get(this.string(a[0]));
      if (!stream || stream.provider !== provider.name)
        throw new Error('Unconfirmed runtime stream');
      if (stream.sandboxId !== call.fence.sandboxId) throw new Error('Stream assignment mismatch');
      if (call.method === 'stream.detach') {
        stream.native?.detach();
        stream.dispose?.();
        stream.ended = true;
        for (const observer of stream.observers) observer.end();
        stream.observers.clear();
        this.streams.delete(stream.id);
        return;
      }
      if (!stream.native) throw new Error('Unconfirmed native stream');
      if (call.method === 'stream.write') {
        stream.native.write(a[1] as string | Buffer);
        return;
      }
      if (call.method === 'stream.resize') {
        stream.native.resize(this.dimension(a[1]), this.dimension(a[2]));
        return;
      }
      if (call.method === 'stream.kill')
        return stream.native.kill(a[1] as NodeJS.Signals | undefined);
      this.unsupported();
    }
    const handle = this.handleFor(call);
    switch (call.method) {
      case 'start':
        return provider.start(handle);
      case 'stop':
        return provider.stop(handle, a[1] as { timeoutSec?: number } | undefined);
      case 'destroy':
        return provider.destroy(handle);
      case 'inspect': {
        const status = await provider.inspect(handle);
        return {
          ...status,
          raw: {
            ...(typeof status.raw === 'object' && status.raw !== null ? status.raw : {}),
            runtimeIdentity: await runtimeStartIdentity(handle, status),
          },
        };
      }
      case 'spawn': {
        // BoxLite exec can resume an exited VM. An attach is observation of an
        // existing running sandbox, so confirm the physical state before exec.
        const runtime = await this.requireRunning(provider, handle, call.fence.sandboxId);
        const native = await provider.spawn(handle, a[1] as ProcessSpec);
        const stream = this.newStream(provider.name, call.fence.sandboxId, native);
        stream.blockingEffect = (a[1] as ProcessSpec).tty !== true;
        native.onData((chunk) =>
          this.emit(stream, { type: 'data', data: chunk.toString('base64') }),
        );
        native.onExit((code) => this.emit(stream, { type: 'exit', code }));
        return {
          streamId: stream.id,
          ref: native.ref,
          runtimeIdentity: await runtimeStartIdentity(handle, runtime),
        };
      }
      case 'updateResources':
        if (!provider.updateResources) this.unsupported();
        return provider.updateResources(handle, a[1] as ResourceQuota);
      case 'jobs.startJob':
        if (!provider.jobs) this.unsupported();
        return provider.jobs.startJob(handle, a[1] as JobSpec);
      case 'jobs.readJob':
        if (!provider.jobs) this.unsupported();
        await this.requireRunning(provider, handle, call.fence.sandboxId);
        return provider.jobs.readJob(
          handle,
          a[1] as JobHandle,
          a[2] as string | undefined,
          a[3] as JobReadOptions | undefined,
        );
      case 'jobs.killJob':
        if (!provider.jobs) this.unsupported();
        return provider.jobs.killJob(handle, a[1] as JobHandle, a[2] as NodeJS.Signals | undefined);
      case 'jobs.releaseJob':
        if (!provider.jobs) this.unsupported();
        return provider.jobs.releaseJob(handle, a[1] as JobHandle);
      case 'files.readFile':
        if (!provider.files) this.unsupported();
        await this.requireRunning(provider, handle, call.fence.sandboxId);
        return provider.files.readFile(handle, this.string(a[1]));
      case 'files.writeFile':
        if (!provider.files) this.unsupported();
        return provider.files.writeFile(handle, this.string(a[1]), a[2] as string | Buffer);
      case 'files.listFiles':
        if (!provider.files) this.unsupported();
        await this.requireRunning(provider, handle, call.fence.sandboxId);
        return provider.files.listFiles(
          handle,
          this.string(a[1]),
          a[2] as { recursive?: boolean; maxEntries?: number } | undefined,
        );
      default:
        this.unsupported();
    }
  }

  private handleFor(call: RuntimeOwnerCall): SandboxHandle {
    const handle = ownerRecord(call.args[0]);
    if (handle.provider !== call.provider || typeof handle.providerSandboxId !== 'string')
      throw new Error('Provider assignment mismatch');
    return this.journal.assignedHandle(
      call.provider,
      handle.providerSandboxId,
      call.fence.sandboxId,
    );
  }
  private async requireRunning(
    provider: SandboxProvider,
    handle: SandboxHandle,
    sandboxId?: string,
  ): Promise<Awaited<ReturnType<SandboxProvider['inspect']>>> {
    if (
      [...this.effectTargets.values()].some(
        (effect) =>
          effect.sandboxId === sandboxId &&
          ['start', 'stop', 'destroy', 'destroyBySandboxId'].includes(effect.method),
      )
    )
      throw new SandboxProviderError(
        SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        'Runtime lifecycle transition is not confirmed; attach is deferred',
        undefined,
        true,
      );
    const runtime = await provider.inspect(handle);
    if (runtime.lifecycleState !== 'instance_running')
      throw new SandboxProviderError(
        SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        'Original running runtime is not confirmed; attach is deferred',
        undefined,
        true,
      );
    return runtime;
  }
  private provider(call: RuntimeOwnerCall): SandboxProvider {
    return this.options.registry.get(call.provider);
  }
  private string(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Invalid runtime string');
    return value;
  }
  private dimension(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10000)
      throw new Error('Invalid terminal dimension');
    return value;
  }
  private unsupported(): never {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.UNSUPPORTED_CAPABILITY,
      'RuntimeOwner operation is unsupported',
    );
  }

  private newStream(provider: string, sandboxId?: string, native?: ProcessStream): OwnerStream {
    const cutoff = this.options.clock.now().getTime() - 10 * 60 * 1000;
    for (const [id, old] of this.streams)
      if (old.ended && old.endedAt !== undefined && old.endedAt < cutoff) {
        old.native?.detach();
        old.dispose?.();
        this.streams.delete(id);
      }
    const stream: OwnerStream = {
      id: randomBytes(20).toString('hex'),
      provider,
      sandboxId,
      native,
      frames: [],
      bytes: 0,
      seq: 0,
      ended: false,
      observers: new Set(),
    };
    this.streams.set(stream.id, stream);
    return stream;
  }
  private emit(
    stream: OwnerStream,
    value: RuntimeOwnerStreamFrame extends infer Frame
      ? Frame extends RuntimeOwnerStreamFrame
        ? Omit<Frame, 'seq'>
        : never
      : never,
  ): void {
    if (stream.ended) return;
    const frame = { ...value, seq: ++stream.seq } as RuntimeOwnerStreamFrame;
    const line = JSON.stringify(frame) + '\n';
    stream.frames.push(frame);
    stream.bytes += Buffer.byteLength(line);
    while (stream.bytes > STREAM_LIMIT && stream.frames.length > 1)
      stream.bytes -= Buffer.byteLength(JSON.stringify(stream.frames.shift()) + '\n');
    for (const observer of stream.observers) {
      if (!observer.write(line) && observer.writableLength > STREAM_LIMIT) observer.destroy();
    }
    if (value.type === 'exit' || value.type === 'error') {
      stream.ended = true;
      stream.endedAt = this.options.clock.now().getTime();
      for (const observer of stream.observers) observer.end();
      stream.observers.clear();
    }
  }
  private async body(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const item of request) {
      const chunk = Buffer.isBuffer(item) ? item : Buffer.from(item as string);
      length += chunk.length;
      if (length > BODY_LIMIT) throw new Error('Runtime request exceeds limit');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(value));
  }
  private failure(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const providerError = error instanceof SandboxProviderError;
    this.json(response, 409, {
      error: {
        code: providerError ? error.code : 'RUNTIME_INTENT_REJECTED',
        message: providerError ? error.message : 'Runtime request could not be safely applied',
        retryable: providerError && error.retryable,
      },
    });
  }
}
