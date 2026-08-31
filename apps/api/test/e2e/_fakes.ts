import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ImageApplicationService } from '@platform/image';
import { formatImageRef, parseImageRef } from '@platform/contracts';
import { OciRegistryClient } from '@platform/image';
import type {
  FileEntry,
  ImageSpecProvider,
  ImageSpecRegistry,
  JobChunk,
  JobCursor,
  JobHandle,
  JobReadOptions,
  JobSpec,
  OpenPtyOptions,
  PreparedWorkspace,
  ProcessSpec,
  ProcessStream,
  ProjectFacade,
  ProjectRuntimeContext,
  ProviderRegistry,
  SandboxFiles,
  SandboxHandle,
  SandboxJobs,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderContext,
  SandboxPtyPort,
  SandboxRuntimeStatus,
  WorkspacePreparer,
} from '@platform/contracts';

/**
 * In-memory doubles so the REST/MCP/terminal e2e prove the wiring WITHOUT a live
 * docker daemon (the real docker providers are exercised only in the skipping
 * docker-required e2e).
 */
const CAPS: SandboxProviderCapabilities = {
  spawnTty: true,
  volumeMount: true,
  updateResources: false,
  pauseResume: false,
  snapshot: false,
  watchEvents: false,
  // both built-ins advertise it since S6; the double carries the two planes to match
  // (CAP-02 pins the bit to their PRESENCE in both directions).
  headlessTask: true,
};

/**
 * A scripted headless job: the e2e drives its stdout and its exit by hand, so the REST
 * / WS / MCP legs can be proven without a container and without waiting on a real CLI.
 */
export class ScriptedJob {
  stdout = '';
  stderr = '';
  exited = false;
  exitCode?: number;
  emit(text: string): void {
    this.stdout += text;
  }
  finish(code?: number): void {
    this.exited = true;
    this.exitCode = code;
  }
}

/**
 * In-memory job plane obeying the SAME rules the real provider does — an opaque cursor
 * and WHOLE-LINE delivery until the job exits. A looser double would hide a half-line
 * bug behind green e2e.
 */
export class FakeJobPlane implements SandboxJobs {
  readonly jobs = new Map<string, ScriptedJob>();
  readonly specs: JobSpec[] = [];
  readonly released: string[] = [];
  readonly kills: { jobId: string; signal?: string }[] = [];
  private seq = 0;

  constructor(private readonly providerName: string) {}

  /** The single job started so far — what an e2e reaches for. */
  latest(): ScriptedJob {
    return [...this.jobs.values()][this.jobs.size - 1];
  }

  async startJob(_h: SandboxHandle, spec: JobSpec): Promise<JobHandle> {
    this.specs.push(spec);
    const jobId = `e2e-job-${++this.seq}`;
    this.jobs.set(jobId, new ScriptedJob());
    return { provider: this.providerName, jobId };
  }

  async readJob(
    _h: SandboxHandle,
    job: JobHandle,
    cursor?: JobCursor,
    opts?: JobReadOptions,
  ): Promise<JobChunk> {
    const state = this.jobs.get(job.jobId);
    if (!state) throw new Error(`no fake job ${job.jobId}`);
    const at = cursor ? (JSON.parse(cursor) as { o: number; e: number }) : { o: 0, e: 0 };
    const read = (): string => Buffer.from(state.stdout, 'utf8').subarray(at.o).toString('utf8');
    let all = read();
    // Same predicate as the real provider: wait when there is no DELIVERABLE WHOLE
    // LINE. Testing byte-emptiness would let a half line skip the wait, which is a
    // busy loop rather than a failure — see AioSandboxAgentClient.readJob.
    if (!all.includes('\n') && !state.exited && (opts?.waitMs ?? 0) > 0) {
      await new Promise((r) => setTimeout(r, Math.min(opts?.waitMs ?? 0, 15)));
      all = read();
    }
    const nl = all.lastIndexOf('\n');
    const stdout = state.exited ? all : nl < 0 ? '' : all.slice(0, nl + 1);
    const stderr = Buffer.from(state.stderr, 'utf8').subarray(at.e).toString('utf8');
    return {
      stdout,
      stderr,
      cursor: JSON.stringify({
        o: at.o + Buffer.byteLength(stdout, 'utf8'),
        e: at.e + Buffer.byteLength(stderr, 'utf8'),
      }),
      status: state.exited ? 'exited' : 'running',
      ...(state.exited && state.exitCode !== undefined ? { exitCode: state.exitCode } : {}),
    };
  }

  async killJob(_h: SandboxHandle, job: JobHandle, signal?: NodeJS.Signals): Promise<void> {
    this.kills.push({ jobId: job.jobId, signal });
    this.jobs.get(job.jobId)?.finish(undefined);
  }

  async releaseJob(_h: SandboxHandle, job: JobHandle): Promise<void> {
    this.released.push(job.jobId);
  }
}

/** In-memory file plane keyed by absolute in-sandbox path. */
export class FakeFilePlane implements SandboxFiles {
  readonly files = new Map<string, Buffer>();

  async readFile(_h: SandboxHandle, path: string): Promise<Buffer | null> {
    return this.files.get(path) ?? null;
  }
  async openFileStream(_h: SandboxHandle, path: string): Promise<NodeJS.ReadableStream | null> {
    const buf = this.files.get(path);
    if (!buf) return null;
    const { Readable } = await import('node:stream');
    return Readable.from(buf);
  }
  async writeFile(_h: SandboxHandle, path: string, content: string | Buffer): Promise<void> {
    this.files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  }
  async listFiles(
    _h: SandboxHandle,
    path: string,
    opts?: { recursive?: boolean; maxEntries?: number },
  ): Promise<FileEntry[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const out: FileEntry[] = [];
    for (const [p, buf] of this.files) {
      if (!p.startsWith(prefix)) continue;
      if (opts?.recursive !== true && p.slice(prefix.length).includes('/')) continue;
      out.push({ path: p, kind: 'file', size: buf.length, modifiedAt: '2026-08-22T00:00:00.000Z' });
    }
    return out.slice(0, opts?.maxEntries ?? out.length);
  }
}

/** A ProcessStream that echoes stdin to stdout — lets the terminal e2e assert a round-trip. */
export class EchoProcessStream implements ProcessStream {
  /**
   * 断开 = detach：替身要照搬真实语义——**不往对面写任何东西**。
   *
   * ⚠️ 这个方法不是形式主义。`ProcessStream.detach()` 是**必选**的，而 `typecheck`
   * 跑的是 `tsc -b`，三个 tsconfig 的 `include` 只覆盖 src ——**测试文件从来
   * 不在类型检查范围内**，vitest 又走 SWC 不做类型检查。于是替身漏实现在两道门禁下
   * 都是隐形的：网关 `handleDisconnect` 无条件调 `detach()`，e2e 里真的抛
   * `TypeError`，被 socket.io 的 disconnect 回调吞掉，测试**照样全绿**。
   */
  detach(): void {
    /* 没有真实传输可关；关键是它存在、且一个字节都不写 */
  }

  readonly ref = 'echo-ref-1';
  private readonly dataCbs: ((c: Buffer) => void)[] = [];
  private readonly exitCbs: ((c: number | null) => void)[] = [];

  onData(cb: (c: Buffer) => void): void {
    this.dataCbs.push(cb);
    setTimeout(() => cb(Buffer.from('/ # ')), 5); // initial prompt banner
  }
  write(data: string | Buffer): void {
    const s = typeof data === 'string' ? data : data.toString('utf8');
    for (const cb of this.dataCbs) cb(Buffer.from(s));
  }
  resize(): void {}
  onExit(cb: (c: number | null) => void): void {
    this.exitCbs.push(cb);
  }
  async kill(): Promise<void> {
    for (const cb of this.exitCbs) cb(0);
  }
}

/**
 * A one-shot exec double: replays output then the exit code, so the platform's
 * `toExecFn` (which resolves on `onExit`) actually settles. Without it every
 * `starting`-段 step that needs an exec — install probe, credential injection, the
 * tmux self-check — would hang forever and the sandbox would sit in `starting`.
 */
export class FakeExecProcessStream implements ProcessStream {
  readonly ref = 'fake-exec-ref';
  /** 一次性 exec：没有可保活的会话，松手即可。 */
  detach(): void {}
  constructor(
    private readonly output: string = '',
    private readonly code: number = 0,
  ) {}
  onData(cb: (c: Buffer) => void): void {
    cb(Buffer.from(this.output, 'utf8'));
  }
  write(): void {}
  resize(): void {}
  onExit(cb: (c: number | null) => void): void {
    cb(this.code);
  }
  async kill(): Promise<void> {}
}

export class FakeProvider implements SandboxProvider {
  readonly capabilities: SandboxProviderCapabilities;
  readonly jobs?: FakeJobPlane;
  readonly files?: FakeFilePlane;
  /**
   * The LAST context handed to `create` — i.e. exactly what 04 §7 时刻④ produced.
   * It is the only place a test can see whether the frozen digest really travelled
   * all the way to the provider, or merely sat in a column nobody read.
   */
  lastContext?: SandboxProviderContext;
  constructor(
    readonly name: string,
    capabilities: SandboxProviderCapabilities = CAPS,
  ) {
    this.capabilities = capabilities;
    if (capabilities.headlessTask) {
      this.jobs = new FakeJobPlane(name);
      this.files = new FakeFilePlane();
    }
  }
  async create(ctx: SandboxProviderContext): Promise<SandboxHandle> {
    this.lastContext = ctx;
    return { provider: this.name, providerSandboxId: `fake-${ctx.sandboxId}` };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
  async inspect(): Promise<SandboxRuntimeStatus> {
    return { lifecycleState: 'instance_running' };
  }
  async spawn(_h: SandboxHandle, spec: ProcessSpec): Promise<ProcessStream> {
    // tty:false is an EXEC (04 §2.3) and must terminate; tty:true is a live terminal.
    return spec.tty ? new EchoProcessStream() : new FakeExecProcessStream('fake 1.0.0', 0);
  }
}

export function makeFakeRegistry(extra: SandboxProvider[] = []): ProviderRegistry {
  const providers = new Map<string, SandboxProvider>([
    ['aio', new FakeProvider('aio')],
    ['boxlite', new FakeProvider('boxlite')],
  ]);
  for (const p of extra) providers.set(p.name, p);
  return {
    defaultProvider: 'aio',
    register: (p) => {
      if (providers.has(p.name)) throw new Error(`duplicate provider ${p.name}`);
      providers.set(p.name, p);
    },
    get: (n) => {
      const p = providers.get(n);
      if (!p) throw new Error(`no provider ${n}`);
      return p;
    },
    has: (n) => providers.has(n),
    list: () => [...providers.values()],
  };
}

export const fakeWorkspace: WorkspacePreparer = {
  async prepare(sandboxId: string): Promise<PreparedWorkspace> {
    return { hostPath: `/tmp/platform-test-ws/${sandboxId}`, baselineExisted: true, entryCount: 1 };
  },
  // ⚠️ **返回 `null` 而不是一个假路径**：e2e 的 fake workspace 从不在磁盘上建目录，
  // 报一个不存在的目录会让销毁流程去登记一条永远打不开的保留卷。真实的
  // `FsWorkspacePreparer` 只有在 `kept` 标记真的写进去之后才报路径（同一条纪律）。
  async cleanup(): Promise<null> {
    return null;
  },
};

/** A project facade that always resolves a ready project (no docker/git needed). */
export const fakeProjectFacade: ProjectFacade = {
  async getRuntimeContextForTask(projectId: string): Promise<ProjectRuntimeContext> {
    return {
      projectId,
      baselinePath: `/tmp/platform-test-baseline/${projectId}`,
      sourceType: 'empty',
      // 03 §1：配额登记的磁盘那一维读它。`null` = 还没量过 ⇒ 落到配置下限。
      baselineSizeBytes: null,
    };
  },
  // 这个 fake 的沙箱没有真工作区（见 `fakeWorkspace.cleanup`），所以登记这一步在
  // e2e 里从不会被调到；实现成 no-op 是为了让契约完整，而不是为了让它"能过"。
  async registerRetainedVolume(): Promise<void> {},
};

/** A provider WITHOUT the two planes — the 409 admission branch needs one to exist. */
export function makeNoHeadlessProvider(name = 'noheadless'): FakeProvider {
  return new FakeProvider(name, { ...CAPS, headlessTask: false });
}

export const fakePtyPort: SandboxPtyPort = {
  async openPty(_sandboxId: string, _opts: OpenPtyOptions): Promise<ProcessStream> {
    return new EchoProcessStream();
  },
};

/**
 * A network-free `ImageSpecProvider` + registry for the e2e.
 *
 * ⚠️ THE SEAM IS THE REGISTRY, NOT THE FACADE, AND THE DIFFERENCE MATTERS. Faking
 * `IMAGE_FACADE` would hand the create door a `manifestId` with no row behind it, and
 * since 0010 `sandboxes.image_ref` is a REAL foreign key — the insert fails, loudly,
 * which is the FK doing exactly its job. Faking the SPEC provider instead leaves the
 * whole chain real (register → validate → freeze digest → door lookup → FK → provision
 * pulls `ref@digest`) and replaces only the one thing an e2e must not depend on: a
 * reachable registry.
 *
 * The digest is derived from the ref so two different refs cannot accidentally share
 * one — a fixed constant would let a test that mixed up two images still pass.
 */
export function makeFakeImageSpecRegistry(): ImageSpecRegistry {
  const provider: ImageSpecProvider = {
    name: 'fake-oci',
    async resolve(ref: string) {
      const parsed = parseImageRef(ref);
      const reference = parsed.digest ?? parsed.tag ?? 'latest';
      const canonical = formatImageRef(parsed.name, reference);
      return {
        ref: canonical,
        digest: (await realDigest(parsed.name, reference)) ?? localRepoDigest(ref) ?? digestOf(ref),
        entrypoint: ['/bin/sh'],
        resolvedAt: '2026-08-25T00:00:00.000Z',
        manifest: {
          name: parsed.name,
          version: reference,
          baseImage: parsed.name,
          entrypointContract: { workdir: '/', entrypoint: ['/bin/sh'] },
          supportedRuntimes: ['codex', 'claude-code'],
          resourceDefaults: { cores: 1, ramMb: 512, diskMb: 1024 },
          // The ROOT must DECLARE tmux (04 §7 ★血统 ③) or `ImageSeeder` refuses to seed
          // it and every spec in this suite loses its catalogue. Derived images inherit
          // the label in reality, so declaring it everywhere IS the honest model.
          labelsRequired: ['platform.tmux'],
          diffIds: fakeDiffIds(canonical),
        },
      };
    },
    /**
     * ⚠️ IT JUDGES NOTHING, AND THE `tmux` BRANCH THAT USED TO LIVE HERE WAS REMOVED
     * ON PURPOSE (04 §7 ★血统). `validate()` stopped judging tmux — labels are
     * inherited, so on a derived image `platform.tmux` describes an ancestor. A double
     * that kept emitting `IMAGE_TMUX_MISSING` would keep a retired rule alive in ten
     * e2e files, and the `{ tmux: false }` knob that drove it had no caller left.
     * The spec judgement is exercised where it is the subject (`images.e2e-spec.ts`).
     */
    validate() {
      return { valid: true, errors: [], warnings: [] };
    },
  };
  return {
    defaultProvider: provider.name,
    register: () => undefined,
    get: () => provider,
    has: () => true,
    list: () => [provider],
  };
}

/** A stable, ref-derived sha256 so two refs never collide on one digest. */
function digestOf(ref: string): string {
  return `sha256:${createHash('sha256').update(ref).digest('hex')}`;
}

/** The one layer every image in this double descends from — the seeded root's own. */
const FAKE_ROOT_LAYER = `sha256:${'r'.repeat(64)}`;

/**
 * `rootfs.diff_ids` for the double, shaped like the real world: the ROOT image
 * (`SANDBOX_DEFAULT_IMAGE`, which `ImageSeeder` registers as `builtin`) is one layer,
 * and every other ref is that layer PLUS one of its own — i.e. a genuine prefix
 * extension, which is exactly what registration verifies (04 §7 ★血统).
 *
 * ⚠️ THIS DOUBLE MAKES EVERY IMAGE LINEAGE-VALID, ON PURPOSE, AND THAT IS NOT WHERE
 * LINEAGE IS VERIFIED. The ten specs that share this helper are about provisioning,
 * terminals and credentials; they need a catalogue that works, not a lineage exam.
 * Letting the rule bite here would only mean 「脚手架替产品做了一件事」 in reverse.
 * The rule itself is exercised where it is the subject: `images.e2e-spec.ts` (the
 * `IMAGE_BASE_REQUIRED` clause, through real HTTP) and the application-layer unit
 * tests for `assertAdmissible`.
 */
function fakeDiffIds(canonicalRef: string): string[] {
  const parsed = parseImageRef(seededRootRef());
  const canonicalRoot = formatImageRef(parsed.name, parsed.digest ?? parsed.tag ?? 'latest');
  if (canonicalRef === canonicalRoot) return [FAKE_ROOT_LAYER];
  return [FAKE_ROOT_LAYER, `sha256:${createHash('sha256').update(canonicalRef).digest('hex')}`];
}

/**
 * The ref `ImageSeeder` will actually seed — it MUST match `ImageSeeder#builtinImageRef`.
 *
 * ⚠️ THIS FALLBACK IS NOT THE SAME AS `registerDefaultImage`'s, AND THAT IS A REAL
 * PRODUCT-SIDE DRIFT, NOT A TEST DETAIL. With `SANDBOX_DEFAULT_IMAGE` unset there are
 * THREE different defaults in the codebase: `ImageSeeder` seeds
 * `ghcr.io/agent-infra/sandbox:latest`, while `ImageFacadeAdapter#defaultImage` and
 * `provision-sandbox.workflow#imageSpecOf` both fall back to `alpine:3.20` — so the
 * image the platform seeds is not the image its create door defaults to. Left as-is
 * here (it predates lineage and fixing it changes door behaviour), but the double has
 * to follow the SEEDER, because the seeder is what决定s which row is `isBuiltin` and
 * therefore which row is the lineage anchor.
 */
function seededRootRef(): string {
  return process.env.SANDBOX_DEFAULT_IMAGE ?? 'ghcr.io/agent-infra/sandbox:latest';
}

/**
 * Ask the REAL registry what this tag resolves to, or `null` if it cannot be reached.
 *
 * ⚠️ THE DIGEST HALF OF THIS DOUBLE HAS TO BE REAL WHEREVER A REAL RUNTIME WILL PULL.
 * Since 04 §7 时刻④ the provider pulls `ref@digest`, so a digest the target registry
 * does not serve lands as `IMAGE_DIGEST_GONE` — correct behaviour, useless as a
 * fixture. And 「the digest docker has locally」 is NOT interchangeable with 「the
 * digest THIS registry serves」: re-pushing an image into the `:5001` staging mirror
 * mints a new manifest digest, which is exactly how the boxlite e2e failed. Only the
 * registry named in the ref can answer this question, so we ask it.
 *
 * Only the digest is real; `validate()` stays a double, because the AIO image does not
 * declare `platform.tmux` and this suite is not about that judgement.
 */
async function realDigest(name: string, reference: string): Promise<string | null> {
  try {
    return (await new OciRegistryClient(4000).fetchManifest(name, reference)).digest;
  } catch {
    return null;
  }
}

/**
 * The REAL registry digest of a locally present image, or `null`.
 *
 * ⚠️ THE DOCKER-BACKED E2E CANNOT USE A SYNTHETIC DIGEST ANY MORE, AND THAT IS THE
 * PINNING WORKING. Since 04 §7 时刻④ the provider pulls `ref@digest`, so a made-up
 * digest lands as `IMAGE_DIGEST_GONE` — correct behaviour, useless as a fixture. The
 * local `RepoDigests[0]` is the digest the daemon itself would resolve the tag to, so
 * `ref@digest` addresses the image already on disk and nothing is fetched.
 *
 * Returns `null` when docker is absent or the image was built locally and never
 * pushed (no repo digest at all) — the caller then falls back to the synthetic value,
 * which is right for the specs that never touch a real daemon.
 */
function localRepoDigest(ref: string): string | null {
  try {
    const out = execFileSync(
      'docker',
      ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', ref],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    const at = out.lastIndexOf('@');
    return at > 0 ? out.slice(at + 1) : null;
  } catch {
    return null;
  }
}

/**
 * Register the platform default image so `POST /api/sandboxes` (which omits `image`)
 * can find a selectable manifest. Returns its manifest id.
 *
 * Every spec that creates a sandbox needs this now: the create door demands a
 * REGISTERED, active, non-invalid image (04 §7 时刻③) instead of accepting any string.
 *
 * ⚠️ IT GOES THROUGH THE APPLICATION SERVICE, NOT SUPERTEST, AND THAT IS NOT LAZINESS.
 * This is per-file SETUP, and supertest binds an ephemeral port per request when the
 * server is not already listening — in a single-process suite that freed port can be
 * reassigned between `address().port` and the write, so the request is answered by a
 * FOREIGN server (`suite-hygiene.e2e-spec.ts` guards exactly this). The image
 * CONTROLLER is covered by its own e2e; here we only need a row in the catalogue.
 */
export async function registerDefaultImage(app: INestApplication): Promise<string> {
  const ref = process.env.SANDBOX_DEFAULT_IMAGE ?? 'alpine:3.20';
  const result = await app.get(ImageApplicationService).registerImage(ref);
  return result.manifest.id;
}
