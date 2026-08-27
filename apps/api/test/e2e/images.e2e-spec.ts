import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DATABASE } from '@platform/shared-kernel';
import {
  IMAGE_SPEC_REGISTRY,
  PROJECT_FACADE,
  SANDBOX_PROVIDER_REGISTRY,
  WORKSPACE_PREPARER,
  formatImageRef,
  parseImageRef,
} from '@platform/contracts';
import type {
  ImageSpecManifest,
  ImageSpecProvider,
  ImageSpecRegistry,
  ProviderRegistry,
  ValidationResult,
} from '@platform/contracts';
import {
  ImageSpecError,
  REF_NOT_FOUND,
  IMAGE_BASE_REQUIRED,
  IMAGE_ENTRYPOINT_INVALID,
} from '@platform/contracts';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { AppModule } from '../../src/app.module';
import { configurePlatformApp } from '../../src/bootstrap/configure-app';
import { useEnv } from './_env';
import { FakeProvider, fakeProjectFacade, fakeWorkspace, makeFakeRegistry } from './_fakes';

/**
 * LINK ⑦ ACCEPTANCE — image registration, validation and the frozen digest
 * (25 §5.7 E2E-7-*; 24 §7; 27 §6). All eight endpoints, end to end, on a real
 * database with the real migrations, the real create door and the real foreign key.
 *
 * The ONE thing doubled is the registry round-trip (`ImageSpecProvider`), because an
 * e2e must not depend on a reachable registry — and because a CONTROLLABLE upstream is
 * what makes 「the tag got re-pushed」 testable at all.
 *
 * ⚠️ THE THREE DIGEST CASES ARE THE POINT OF THIS FILE. The other seven scenarios
 * (三级反馈, env rules, soft delete, secret semantics) were all specified before the
 * slice, and NONE of them would have gone red against the implementation that shipped
 * `{ ref, digest: 'sha256:unresolved' }` — digest was simply never in an assertion
 * (25 §5.7 ⚠️).
 */
/**
 * ⚠️ THE CATALOGUE NOW HAS A SHAPE, NOT JUST ROWS (04 §7 ★血统). `SANDBOX_DEFAULT_IMAGE`
 * is the platform ROOT: `ImageSeeder` registers it at bootstrap with `builtin: true`,
 * and every image a user registers must descend from it. So this file needs THREE
 * kinds of coordinate, and mixing them up is the mistake it is built to catch:
 *   · BASE_REF   — the root. Seeded, `isBuiltin`, exempt from lineage, undeletable.
 *   · REF/…      — ordinary user images, built FROM the root (diff_ids prefix).
 *   · ALIEN_REF  — an image built from something else entirely ⇒ IMAGE_BASE_REQUIRED.
 */
const BASE_REF = 'ghcr.io/platform/base:v1';
const IMAGE = 'ghcr.io/example/derived';
const REF = `${IMAGE}:v1`;
const OTHER_REF = 'ghcr.io/example/other:v1';
const ALIEN_REF = 'ghcr.io/example/alien:v1';

const digestFor = (seed: string): string =>
  `sha256:${createHash('sha256').update(seed).digest('hex')}`;
/** The root's single layer. Every compliant image repeats it as its first entry. */
const ROOT_LAYER = digestFor('root-layer');

/** A registry we can re-push a tag on. */
class ScriptedSpecProvider implements ImageSpecProvider {
  readonly name = 'scripted';
  /** ref → the digest the tag currently resolves to. */
  readonly digests = new Map<string, string>();
  /**
   * refs whose image FAILS the spec judgement (`validate()`).
   *
   * ⚠️ IT USED TO BE `tmuxless`, AND THE RENAME IS NOT COSMETIC. `validate()` stopped
   * judging tmux in 2026-08 — labels are inherited, so on a derived image
   * `platform.tmux` describes an ancestor. Driving this fixture with a tmux verdict
   * would keep asserting, over real HTTP, a rule the platform no longer has. The
   * entry-point contract is what `validate()` genuinely still owns (IS-03).
   */
  readonly broken = new Set<string>();
  /** refs whose image is NOT built on the platform root ⇒ lineage refusal. */
  readonly alien = new Set<string>([ALIEN_REF]);
  /** refs the registry answers 404 for. */
  readonly missing = new Set<string>();

  async resolve(ref: string) {
    if (this.missing.has(ref)) {
      throw new ImageSpecError(REF_NOT_FOUND, `image '${ref}' not found in registry`);
    }
    const parsed = parseImageRef(ref);
    const reference = parsed.digest ?? parsed.tag ?? 'latest';
    const canonical = formatImageRef(parsed.name, reference);
    const digest = this.digests.get(canonical) ?? digestFor(canonical);
    this.digests.set(canonical, digest);
    return {
      ref: canonical,
      digest: parsed.digest ?? digest,
      entrypoint: ['/bin/sh'],
      resolvedAt: '2026-08-25T00:00:00.000Z',
      manifest: {
        name: parsed.name,
        version: reference,
        baseImage: parsed.name,
        entrypointContract: { workdir: '/', entrypoint: ['/bin/sh'] },
        // ⚠️ ONLY `codex`. The platform also offers `claude-code`, and an image that
        // honestly says it does not preinstall it MUST still be selectable for it —
        // see 「未预装 ≠ 不可选」 below. A fixture that declared both would make that
        // clause unfalsifiable.
        supportedRuntimes: ['codex'],
        resourceDefaults: { cores: 2, ramMb: 1024, diskMb: 4096 },
        labelsRequired: ['platform.tmux'],
        diffIds: this.diffIdsFor(canonical),
      },
    };
  }

  /** The root is one layer; a compliant image is that layer plus its own. */
  private diffIdsFor(canonical: string): string[] {
    if (canonical === BASE_REF) return [ROOT_LAYER];
    if (this.alien.has(canonical)) return [digestFor(`alien-${canonical}`)];
    return [ROOT_LAYER, digestFor(`layer-${canonical}`)];
  }

  validate(manifest: ImageSpecManifest): ValidationResult {
    const ref = formatImageRef(manifest.name, manifest.version);
    const errors = this.broken.has(ref)
      ? [
          {
            code: IMAGE_ENTRYPOINT_INVALID,
            path: 'entrypointContract.entrypoint',
            message: '镜像既没有 Entrypoint 也没有 Cmd',
          },
        ]
      : [];
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  /** Simulate 「上游把同一个 tag 重推到不同 bits」. */
  rePush(ref: string, seed: string): void {
    this.digests.set(ref, digestFor(seed));
  }
}

let app: INestApplication;
let restoreEnv: () => void;
let spec: ScriptedSpecProvider;
let providers: ProviderRegistry;

const api = () => request(app.getHttpServer());

beforeAll(async () => {
  restoreEnv = useEnv({
    DATABASE_URL: ':memory:',
    ACCESS_PASSCODE: undefined,
    SANDBOX_DEFAULT_IMAGE: BASE_REF,
    PLATFORM_MASTER_KEY: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
  });
  spec = new ScriptedSpecProvider();
  const specRegistry: ImageSpecRegistry = {
    defaultProvider: spec.name,
    register: () => undefined,
    get: () => spec,
    has: () => true,
    list: () => [spec],
  };
  providers = makeFakeRegistry();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SANDBOX_PROVIDER_REGISTRY)
    .useValue(providers)
    .overrideProvider(WORKSPACE_PREPARER)
    .useValue(fakeWorkspace)
    .overrideProvider(PROJECT_FACADE)
    .useValue(fakeProjectFacade)
    .overrideProvider(IMAGE_SPEC_REGISTRY)
    .useValue(specRegistry)
    .compile();
  app = moduleRef.createNestApplication();
  configurePlatformApp(app);
  await app.init();
  await app.listen(0);
});

afterAll(async () => {
  await app?.close();
  restoreEnv?.();
});

async function waitForStatus(id: string, want: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const res = await api().get(`/api/sandboxes/${id}`);
    const body = res.body as { status?: string; failureCode?: string };
    if (body.status === want) return;
    if (body.status === 'failed') throw new Error(`sandbox failed: ${JSON.stringify(body)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`sandbox ${id} never reached ${want}`);
}

/** Every non-2xx body must be a complete envelope (审计 P1-4, 10 §6.8). */
function expectEnvelope(body: unknown): Record<string, unknown> {
  const e = body as Record<string, unknown>;
  expect(typeof e.code).toBe('string');
  expect(typeof e.message).toBe('string');
  expect(typeof e.retryable).toBe('boolean');
  expect(typeof e.traceId).toBe('string');
  return e;
}

describe('E2E-7 registration freezes a REAL digest (04 §7 时刻①)', () => {
  let manifestId = '';

  it('the platform ROOT is already in the catalogue — `ImageSeeder` put it there', async () => {
    // ⚠️ THE SEEDER IS PRODUCT CODE AND IT RUNS IN `app.init()`. Before this clause the
    // file registered `SANDBOX_DEFAULT_IMAGE` itself and then asserted 201 — i.e. the
    // test was standing in for the seeder and would have stayed green with the seeder
    // deleted (LIVE-RUN-FINDINGS 共性 2). Now the root is expected to be THERE, and
    // every later clause registers something DERIVED from it, which is the shape the
    // product actually has since lineage became the compliance rule.
    const rows = (await api().get('/api/images').expect(200)).body as {
      ref: string;
      isBuiltin: boolean;
      digest: string;
    }[];
    const root = rows.find((r) => r.ref === BASE_REF);
    expect(root, 'the seeder must have registered SANDBOX_DEFAULT_IMAGE').toBeDefined();
    expect(root?.isBuiltin, 'I-IMG-4: 平台自带的那张不可删除').toBe(true);
    expect(root?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('E2E-7-digestFrozen: the stored digest is a real sha256 AND the one the registry returned', async () => {
    const res = await api().post('/api/images').send({ ref: REF }).expect(201);
    const body = res.body as { manifest: Record<string, string>; validation: { status: string } };
    manifestId = body.manifest.id;

    // ⚠️ 「digest 非空」 IS NOT THE ASSERTION. `'sha256:unresolved'` is non-empty, and
    // that placeholder is exactly what this repo shipped for the whole life of
    // `imageSpecOf()` — a truthiness check goes GREEN on it (04 §10.4 IS-01).
    expect(body.manifest.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.manifest.digest).not.toBe('sha256:unresolved');
    // …and it is the value the registry ACTUALLY answered with, not a locally minted
    // hash that merely has the right shape.
    expect(body.manifest.digest).toBe(spec.digests.get(REF));
    expect(body.validation.status).toBe('valid');

    // Read back through the API: the column really holds it (13 §2.4.2 CHECK).
    const list = await api().get('/api/images').expect(200);
    const rows = list.body as { id: string; digest: string; resolvedAt: string }[];
    const stored = rows.find((r) => r.id === manifestId);
    expect(stored?.digest).toBe(body.manifest.digest);
    // 27 §6: without `resolvedAt` the card degrades to 「最后验证 N 小时前」 with
    // nothing behind it, and three UI affordances stop rendering.
    expect(Number.isNaN(Date.parse(stored?.resolvedAt ?? ''))).toBe(false);
  });

  it('⭐ 血统被**记下来**了：派生行带着根镜像的 digest，根镜像自己是 null', async () => {
    // ⚠️ 判定那一刻就知道匹配上了哪一张锚点，以前只把「过 / 不过」带走。没有这一列，
    // 平台**答不出**谁基于谁——卡片显示不了「基于 X」，平台换 base 之后也说不出哪些
    // 客户自定义镜像该重建。这条用例走真的 HTTP，因为契约承诺的是**线上的字段**：
    // 服务里算对了但没进 DTO，前端一样什么都拿不到。
    const rows = (await api().get('/api/images').expect(200)).body as {
      ref: string;
      isBuiltin: boolean;
      digest: string;
      derivedFromDigest: string | null;
    }[];
    const root = rows.find((r) => r.ref === BASE_REF);
    const derived = rows.find((r) => r.ref === REF);
    expect(root).toBeDefined();
    expect(derived).toBeDefined();

    expect(derived?.derivedFromDigest).toBe(root?.digest);
    // …而不是它自己的 digest：拿自己填这一列，字段永远非空、看起来一切正常，血统图
    // 却是一堆自环。
    expect(derived?.derivedFromDigest).not.toBe(derived?.digest);

    // ⚠️ 根镜像是 `null`，而这个 `null` 的意思是「它就是锚点，没有平台祖先」，
    // **不是**「未基于平台镜像」——切片前的存量行也写 `null`，区分两者的是 `isBuiltin`。
    expect(root?.derivedFromDigest).toBeNull();
    expect(root?.isBuiltin).toBe(true);
  });

  it('is idempotent on (image, digest): the same URI again is 200 and the SAME row', async () => {
    const before = ((await api().get('/api/images').expect(200)).body as unknown[]).length;
    const res = await api().post('/api/images').send({ ref: REF }).expect(200);
    expect((res.body as { manifest: { id: string } }).manifest.id).toBe(manifestId);
    expect(((await api().get('/api/images').expect(200)).body as unknown[]).length).toBe(before);
  });

  it('⭐ MANIFEST_INVALID is a 422 whose details carry IMAGE_BASE_REQUIRED, and stores NOTHING', async () => {
    const before = ((await api().get('/api/images')).body as unknown[]).length;

    const res = await api().post('/api/images').send({ ref: ALIEN_REF }).expect(422);
    const envelope = expectEnvelope(res.body);
    expect(envelope.code).toBe('MANIFEST_INVALID');
    expect(envelope.sideEffectFree).toBe(true);
    // ⚠️ `IMAGE_BASE_REQUIRED` LIVES IN `details[]`, NEVER AS THE TOP-LEVEL CODE
    // (10 §6.8) — same placement as the other registration findings, because the
    // frontend copy table is keyed on the TOP-level code and the ❌ card renders
    // `details[]` line by line (P21-4 §5).
    const details = envelope.details as { code: string; path: string; message: string }[];
    expect(details.map((d) => d.code)).toContain(IMAGE_BASE_REQUIRED);
    expect(details[0].path).toBeTruthy();
    // ⚠️ THE SENTENCE MUST NAME THE BASE. 「用平台预制镜像」 is correct and unusable —
    // the user does not know which one. This is the whole reason the anchor query
    // carries a `ref` alongside the layer list.
    expect(details[0].message).toContain('FROM');
    expect(details[0].message).toContain(BASE_REF);

    expect(((await api().get('/api/images')).body as unknown[]).length).toBe(before);
  });

  it('⭐ 预检与注册同口径：pre-flight already says invalid for the same image', async () => {
    // If pre-flight answered ✅ and [保存] answered 422, each half would be internally
    // correct and the pair would be a lie — the wizard would collect a URI, promise it
    // is fine, and then refuse it (P21-4 §5 三级反馈).
    const res = await api().post('/api/images/validate').send({ ref: ALIEN_REF }).expect(200);
    const body = res.body as { status: string; errors: { code: string }[] };
    expect(body.status).toBe('invalid');
    expect(body.errors.map((e) => e.code)).toContain(IMAGE_BASE_REQUIRED);
  });

  it('the spec judgement still stands on its own: a broken entry point is 422 too', async () => {
    const badRef = 'ghcr.io/example/no-entry:1';
    spec.broken.add(badRef);
    const before = ((await api().get('/api/images')).body as unknown[]).length;
    const res = await api().post('/api/images').send({ ref: badRef }).expect(422);
    const envelope = expectEnvelope(res.body);
    expect(envelope.code).toBe('MANIFEST_INVALID');
    expect((envelope.details as { code: string }[]).map((d) => d.code)).toContain(
      IMAGE_ENTRYPOINT_INVALID,
    );
    expect(((await api().get('/api/images')).body as unknown[]).length).toBe(before);
  });

  it('REF_NOT_FOUND is a 404, not a 502 — the ref is wrong, the registry is fine', async () => {
    spec.missing.add('ghcr.io/example/ghost:1');
    const res = await api()
      .post('/api/images')
      .send({ ref: 'ghcr.io/example/ghost:1' })
      .expect(404);
    expect(expectEnvelope(res.body).code).toBe('REF_NOT_FOUND');
  });

  it('E2E-7-validatePreflight: POST /api/images/validate judges without storing', async () => {
    const before = ((await api().get('/api/images')).body as unknown[]).length;
    const res = await api().post('/api/images/validate').send({ ref: OTHER_REF }).expect(200);
    expect((res.body as { status: string }).status).toBe('valid');
    expect(((await api().get('/api/images')).body as unknown[]).length).toBe(before);
  });
});

describe('E2E-7-digestPinned: the frozen digest reaches provider.create (04 §7 时刻④)', () => {
  it('hands the provider `ref@digest`, and the sandbox row points at the manifest', async () => {
    const images = (await api().get('/api/images').expect(200)).body as {
      id: string;
      digest: string;
      ref: string;
    }[];
    const image = images.find((i) => i.ref === REF);
    expect(image).toBeDefined();

    const created = await api()
      .post('/api/sandboxes')
      .send({ projectId: 'prj-e2e', runtime: 'codex', image: image?.id })
      .expect(201);
    const sandboxId = (created.body as { id: string }).id;
    await waitForStatus(sandboxId, 'running');

    // ⚠️ THIS IS THE CLAUSE THAT WOULD HAVE STAYED GREEN FOREVER WITHOUT BEING WRITTEN.
    // Freezing a digest into a column that nobody reads at provision time is
    // bookkeeping; 「不可变坐标」 only becomes true when the string handed to the
    // provider IS the digest (04 §7 「③④一个都不能省」).
    const ctx = (providers.get('aio') as FakeProvider).lastContext;
    expect(ctx?.image.digest).toBe(image?.digest);
    expect(ctx?.image.digest).not.toBe('sha256:unresolved');

    // …and the row stores the MANIFEST ID, not the coordinate: same column, new
    // meaning (04 §7 ⚠️, 13 §2.1).
    const db = app.get<BetterSQLite3Database<Record<string, never>>>(DATABASE);
    const row = db.get<{ image_ref: string }>(
      sql`select image_ref from sandboxes where id = ${sandboxId}`,
    );
    expect(row.image_ref).toBe(image?.id);
    expect(row.image_ref).not.toBe(REF);
  });
});

describe('E2E-7-tagDrift: a re-pushed tag does NOT move a running coordinate', () => {
  let originalDigest = '';
  let originalId = '';

  it('①  after the re-push, a NEW Task still runs the digest registered earlier', async () => {
    const images = (await api().get('/api/images').expect(200)).body as {
      id: string;
      digest: string;
      ref: string;
    }[];
    const image = images.find((i) => i.ref === REF);
    originalDigest = image?.digest ?? '';
    originalId = image?.id ?? '';

    spec.rePush(REF, 'RE-PUSHED-BITS');
    expect(spec.digests.get(REF)).not.toBe(originalDigest);

    const created = await api()
      .post('/api/sandboxes')
      .send({ projectId: 'prj-e2e', runtime: 'codex', image: originalId })
      .expect(201);
    await waitForStatus((created.body as { id: string }).id, 'running');

    // The coordinate does not move because nobody asked it to — the door reads the
    // database, never the registry (that is also why the door can promise
    // `retryable:false` for everything it refuses, 10 §6.8).
    const ctx = (providers.get('aio') as FakeProvider).lastContext;
    expect(ctx?.image.digest).toBe(originalDigest);
  });

  it('②  re-validation REPORTS the migration 旧 → 新 and does NOT write the new verdict back', async () => {
    // The re-pushed bits ALSO broke their entry point. That is what makes the two
    // implementations distinguishable: the upstream verdict is now `invalid` while
    // THIS row's bits are still the ones that passed.
    spec.broken.add(REF);
    const res = await api().post(`/api/images/${originalId}/validate`).expect(200);
    const body = res.body as {
      status: string;
      currentDigest: string;
      upstreamDigest: string;
      digestChanged: boolean;
    };
    // ⚠️ NOT 「验证通过」. A tag that resolves elsewhere is a COORDINATE MIGRATION, and
    // the user has a right to know their image changed bits (04 §7 时刻②). A response
    // that only said `status: 'valid'` would be true and useless.
    expect(body.digestChanged).toBe(true);
    expect(body.currentDigest).toBe(originalDigest);
    expect(body.upstreamDigest).toBe(spec.digests.get(REF));
    expect(body.status).toBe('invalid');

    const rows = (await api().get('/api/images').expect(200)).body as {
      id: string;
      digest: string;
      validationStatus: string;
    }[];
    const row = rows.find((r) => r.id === originalId);
    // `digest` is this row's identity and can never be UPDATEd (I-IMG-7)…
    expect(row?.digest).toBe(originalDigest);
    // ⚠️ …AND NEITHER MAY THE VERDICT BE. The re-resolved manifest describes DIFFERENT
    // BITS; stamping its status here would make the row claim something about bits it
    // does not contain — and, worse, would silently retire a perfectly good version
    // (I-IMG-2 at the door) because of a change upstream that this row never took.
    // Writing back unconditionally passes every other assertion in this test.
    expect(row?.validationStatus).toBe('valid');

    spec.broken.delete(REF);
  });

  it('check-update reports the drift without storing anything', async () => {
    const before = ((await api().get('/api/images')).body as unknown[]).length;
    const res = await api().post(`/api/images/${originalId}/check-update`).expect(200);
    const body = res.body as {
      current: { digest: string };
      upstream: { digest: string } | null;
      changed: boolean;
    };
    expect(body.changed).toBe(true);
    expect(body.current.digest).toBe(originalDigest);
    expect(body.upstream?.digest).toBe(spec.digests.get(REF));
    expect(((await api().get('/api/images')).body as unknown[]).length).toBe(before);
  });

  it('re-registering INSERTs a second row and leaves the incumbent active', async () => {
    const res = await api().post('/api/images').send({ ref: REF }).expect(201);
    const fresh = (res.body as { manifest: { id: string; digest: string; isActive: boolean } })
      .manifest;
    expect(fresh.id).not.toBe(originalId);
    expect(fresh.digest).toBe(spec.digests.get(REF));
    // ⚠️ NOT ACTIVE YET. Swapping which bits every future Task runs is not something a
    // re-paste should do behind the user's back (27 §6).
    expect(fresh.isActive).toBe(false);

    const rows = (await api().get('/api/images').expect(200)).body as {
      id: string;
      ref: string;
      isActive: boolean;
    }[];
    expect(rows.filter((r) => r.ref === REF && r.isActive).map((r) => r.id)).toEqual([originalId]);
  });

  it('activate swaps the pointer — and rollback is the SAME action', async () => {
    const rows = (await api().get('/api/images').expect(200)).body as {
      id: string;
      ref: string;
      isActive: boolean;
    }[];
    const fresh = rows.find((r) => r.ref === REF && !r.isActive);

    await api()
      .post(`/api/images/${fresh?.id ?? ''}/activate`)
      .expect(200);
    let live = (
      (await api().get('/api/images').expect(200)).body as {
        id: string;
        ref: string;
        isActive: boolean;
      }[]
    ).filter((r) => r.ref === REF && r.isActive);
    expect(live.map((r) => r.id)).toEqual([fresh?.id]);

    // …and back again. 「回滚」 is not an exception path — it is the same endpoint in
    // the other direction (13 §2.4.2 ★★).
    await api().post(`/api/images/${originalId}/activate`).expect(200);
    live = (
      (await api().get('/api/images').expect(200)).body as {
        id: string;
        ref: string;
        isActive: boolean;
      }[]
    ).filter((r) => r.ref === REF && r.isActive);
    expect(live.map((r) => r.id)).toEqual([originalId]);
  });
});

describe('PATCH is the only entry point for the two mutable fields (27 §6)', () => {
  let target = '';

  beforeAll(async () => {
    const res = await api().post('/api/images').send({ ref: OTHER_REF }).expect(201);
    target = (res.body as { manifest: { id: string } }).manifest.id;
  });

  it('refuses `isActive: true` and points at /activate (10 §6 ★)', async () => {
    const res = await api().patch(`/api/images/${target}`).send({ isActive: true }).expect(400);
    const envelope = expectEnvelope(res.body);
    // Enabling a version necessarily retires the current holder of the tag: 副作用大于
    // 字面. The message has to name the way out, or the 400 is just a wall.
    expect(String(envelope.message)).toContain('activate');
  });

  it('E2E-7-patch: `isActive:false` removes it from the selectable list, history intact', async () => {
    await api().patch(`/api/images/${target}`).send({ isActive: false }).expect(200);
    const selectable = (await api().get('/api/images?runtimeId=codex').expect(200)).body as {
      id: string;
    }[];
    expect(selectable.map((r) => r.id)).not.toContain(target);
    // The management page still sees it — 「历史版本收在卡片背后」, not deleted.
    const all = (await api().get('/api/images').expect(200)).body as { id: string }[];
    expect(all.map((r) => r.id)).toContain(target);
  });

  it('the create door refuses a RETIRED version (I-IMG-3), 零副作用', async () => {
    const before = ((await api().get('/api/sandboxes').expect(200)).body as unknown[]).length;
    const res = await api()
      .post('/api/sandboxes')
      .send({ projectId: 'prj-e2e', runtime: 'codex', image: target })
      .expect(400);
    const envelope = expectEnvelope(res.body);
    expect(envelope.code).toBe('INVALID_IMAGE_REFERENCE');
    expect(envelope.retryable).toBe(false);
    // ⚠️ EARNED BY POSITION, NOT BY THIS THROW SITE REMEMBERING A FIELD (04 §5 /
    // `atDoor`): the check was added INSIDE the door region, so the flag is correct
    // without its author doing anything.
    expect(envelope.sideEffectFree).toBe(true);
    expect(((await api().get('/api/sandboxes').expect(200)).body as unknown[]).length).toBe(before);
  });

  it('the create door refuses an image that was never registered', async () => {
    const res = await api()
      .post('/api/sandboxes')
      .send({ projectId: 'prj-e2e', runtime: 'codex', image: 'ghcr.io/never/registered:1' })
      .expect(400);
    const envelope = expectEnvelope(res.body);
    // ⚠️ `IMAGE_NOT_REGISTERED`, NOT `INVALID_IMAGE_REFERENCE`, AND THE TWO ARE
    // DELIBERATELY SEPARATE CODES (image-facade.port.ts / 10 §6.8): this address is
    // perfectly legal, the platform simply has no live image on it, and the way out is
    // 「去镜像管理注册一张」 rather than 「改地址」. Collapsing them would tell a
    // brand-new user that the address they never typed contains a control character.
    expect(envelope.code).toBe('IMAGE_NOT_REGISTERED');
    expect(envelope.sideEffectFree).toBe(true);
    // The sentence has to say what to DO — 「先去注册」 — because the request is not
    // retryable and there is nothing on screen to act on.
    expect(String(envelope.message)).toMatch(/注册/);
  });
});

describe('E2E-7-envReject / E2E-7-secretKeep: run parameters (23 §9.3, I-IMG-5)', () => {
  let target = '';

  beforeAll(async () => {
    const res = await api().post('/api/images').send({ ref: 'ghcr.io/example/envs:1' }).expect(201);
    target = (res.body as { manifest: { id: string } }).manifest.id;
  });

  it('rejects a reserved name with VALIDATION_FAILED + a locatable details entry', async () => {
    const res = await api()
      .patch(`/api/images/${target}`)
      .send({ imageConfig: { env: [{ key: 'OPENAI_API_KEY', value: 'sk-live-xyz' }] } })
      .expect(400);
    const envelope = expectEnvelope(res.body);
    // Top-level `VALIDATION_FAILED`, the FOUR `ENV_*` codes in `details[].code`
    // (10 §6.8 本轮补的两条定案 ①) — the frontend copy table is keyed on the top code.
    expect(envelope.code).toBe('VALIDATION_FAILED');
    expect(envelope.sideEffectFree).toBe(true);
    const details = envelope.details as { code: string; path: string; message: string }[];
    expect(details[0].code).toBe('ENV_NAME_RESERVED');
    expect(details[0].path).toBe('env[0].key');
    // ⚠️ THE SUBMITTED VALUE MUST NOT COME BACK. An env value is the likeliest place
    // for a plaintext token, and this body is rendered, logged and screenshotted.
    expect(JSON.stringify(res.body)).not.toContain('sk-live-xyz');
  });

  it('rejects 51 entries with the ceiling stated', async () => {
    const env = Array.from({ length: 51 }, (_, i) => ({ key: `K${String(i)}`, value: 'v' }));
    const res = await api()
      .patch(`/api/images/${target}`)
      .send({ imageConfig: { env } })
      .expect(400);
    const details = (res.body as { details: { code: string; message: string }[] }).details;
    expect(details[0].code).toBe('ENV_LIMIT_EXCEEDED');
    expect(details[0].message).toContain('50');
  });

  it('never echoes a secret, and an empty value KEEPS the stored ciphertext', async () => {
    const saved = await api()
      .patch(`/api/images/${target}`)
      .send({
        imageConfig: {
          env: [
            { key: 'LOG_LEVEL', value: 'debug' },
            { key: 'MY_TOKEN', value: 'super-secret-value', secret: true },
          ],
        },
      })
      .expect(200);
    const config = (saved.body as { imageConfig: { env: { key: string; value: string }[] } })
      .imageConfig;
    expect(config.env.find((e) => e.key === 'MY_TOKEN')?.value).toBe('');
    expect(JSON.stringify(saved.body)).not.toContain('super-secret-value');

    const db = app.get<BetterSQLite3Database<Record<string, never>>>(DATABASE);
    const readBlob = (): string => {
      const row = db.get<{ image_config: string }>(
        sql`select image_config from image_manifests where id = ${target}`,
      );
      // Plaintext must never be in the column either (13 §2.4.3).
      expect(row.image_config).not.toContain('super-secret-value');
      return JSON.stringify(
        (
          JSON.parse(row.image_config) as { env: { key: string; valueEncrypted?: unknown }[] }
        ).env.find((e) => e.key === 'MY_TOKEN')?.valueEncrypted,
      );
    };
    const before = readBlob();

    // E2E-7-secretKeep: re-submitting the MASKED form must be a no-op, not a wipe —
    // outbound secrets are `''`, so the two directions share the sentinel on purpose.
    await api()
      .patch(`/api/images/${target}`)
      .send({
        imageConfig: {
          env: [
            { key: 'LOG_LEVEL', value: 'info' },
            { key: 'MY_TOKEN', value: '', secret: true },
          ],
        },
      })
      .expect(200);
    expect(readBlob()).toBe(before);
  });
});

describe('the run parameters actually reach the container (05 §4.1 / 24 §7)', () => {
  it('injects the image env, with secrets decrypted, into provider.create', async () => {
    const created = await api()
      .post('/api/images')
      .send({ ref: 'ghcr.io/example/with-env:1' })
      .expect(201);
    const id = (created.body as { manifest: { id: string } }).manifest.id;
    await api()
      .patch(`/api/images/${id}`)
      .send({
        imageConfig: {
          env: [
            { key: 'LOG_LEVEL', value: 'trace' },
            { key: 'MY_TOKEN', value: 'plaintext-at-inject-time', secret: true },
          ],
        },
      })
      .expect(200);

    const sandbox = await api()
      .post('/api/sandboxes')
      .send({ projectId: 'prj-e2e', runtime: 'codex', image: id })
      .expect(201);
    await waitForStatus((sandbox.body as { id: string }).id, 'running');

    // ⚠️ WITHOUT THIS, THE [运行参数] EDITOR IS A SETTING WITH NO EFFECT: values are
    // validated, encrypted, stored, listed — and never reach anything. That is worse
    // than not shipping the field, because the UI says it worked.
    const env = (providers.get('aio') as FakeProvider).lastContext?.env ?? {};
    expect(env.LOG_LEVEL).toBe('trace');
    // …and the SECRET is decrypted on the way in. Handing the container a base64 blob
    // where a token belongs fails in a way nobody can read.
    expect(env.MY_TOKEN).toBe('plaintext-at-inject-time');
  });
});

describe('re-validation can turn a row invalid, and then it is unusable everywhere', () => {
  let target = '';

  beforeAll(async () => {
    const ref = 'ghcr.io/example/rots:1';
    const res = await api().post('/api/images').send({ ref }).expect(201);
    target = (res.body as { manifest: { id: string } }).manifest.id;
    // The upstream image broke its entry point without changing bits.
    spec.broken.add(ref);
  });

  it('writes the new verdict back when the digest did NOT move', async () => {
    const res = await api().post(`/api/images/${target}/validate`).expect(200);
    const body = res.body as { status: string; digestChanged: boolean };
    expect(body.digestChanged).toBe(false);
    expect(body.status).toBe('invalid');

    const rows = (await api().get('/api/images').expect(200)).body as {
      id: string;
      validationStatus: string;
      validationErrors: { code: string }[] | null;
    }[];
    const row = rows.find((r) => r.id === target);
    expect(row?.validationStatus).toBe('invalid');
    // 13 §2.4.2: `invalid` ⇒ the findings column is non-empty, or the verdict is
    // unexplainable to the user.
    expect(row?.validationErrors?.map((e) => e.code)).toContain(IMAGE_ENTRYPOINT_INVALID);
  });

  it('an invalid version cannot be activated (I-IMG-9 → INVALID_STATE 409)', async () => {
    const res = await api().post(`/api/images/${target}/activate`).expect(409);
    expect(expectEnvelope(res.body).code).toBe('INVALID_STATE');
  });

  it('and the create door refuses it too (I-IMG-2)', async () => {
    const res = await api()
      .post('/api/sandboxes')
      .send({ projectId: 'prj-e2e', runtime: 'codex', image: target })
      .expect(400);
    expect(expectEnvelope(res.body).code).toBe('INVALID_IMAGE_REFERENCE');
  });
});

describe('DELETE is hard, and RESTRICT is what makes 「使用中不可删」 true', () => {
  it('E2E-7-restrict: 409 while a Task references the version', async () => {
    const rows = (await api().get('/api/images').expect(200)).body as {
      id: string;
      ref: string;
      isActive: boolean;
      isBuiltin: boolean;
    }[];
    // ⚠️ A NON-BUILTIN ROW ON PURPOSE. `assertDeletable()` (I-IMG-4) runs BEFORE the
    // reference count, so aiming this at the seeded root would 409 for the OTHER
    // reason and this clause would pass while proving nothing about RESTRICT.
    const inUse = rows.find((r) => r.ref === REF && r.isActive && !r.isBuiltin);
    expect(inUse, 'the digest-pinned Task above ran on this row').toBeDefined();
    const res = await api()
      .delete(`/api/images/${inUse?.id ?? ''}`)
      .expect(409);
    const envelope = expectEnvelope(res.body);
    expect(envelope.code).toBe('INVALID_STATE');
    // The message names the alternative, because 「删不掉」 without 「改为禁用」 leaves
    // the user stuck (P21-4 §6).
    expect(String(envelope.message)).toMatch(/禁用/);
    expect(String(envelope.message)).toMatch(/Task/);
  });

  it('I-IMG-4: the seeded ROOT cannot be deleted at all, used or not', async () => {
    // 删掉平台自带的那张 = 平台从此建不出 Task，而 [删除] 按钮本身不会说这件事。
    // 血统落地后它更要命：根镜像还是所有自定义镜像的锚点，删了它连注册都做不了。
    const rows = (await api().get('/api/images').expect(200)).body as {
      id: string;
      ref: string;
      isBuiltin: boolean;
    }[];
    const root = rows.find((r) => r.ref === BASE_REF);
    expect(root?.isBuiltin).toBe(true);
    const res = await api()
      .delete(`/api/images/${root?.id ?? ''}`)
      .expect(409);
    expect(expectEnvelope(res.body).code).toBe('INVALID_STATE');
  });

  it('deletes a version nothing references, and 404s afterwards', async () => {
    const created = await api()
      .post('/api/images')
      .send({ ref: 'ghcr.io/example/disposable:1' })
      .expect(201);
    const id = (created.body as { manifest: { id: string } }).manifest.id;
    await api().delete(`/api/images/${id}`).expect(204);
    const res = await api().post(`/api/images/${id}/activate`).expect(404);
    expect(expectEnvelope(res.body).code).toBe('NOT_FOUND');
  });
});

describe('a digest-pinned registration cannot drift, and says so', () => {
  it('check-update on a digest-form row is 409, not a fake 「no update」', async () => {
    const pinned = `${IMAGE}@${digestFor('pinned-bits')}`;
    const created = await api().post('/api/images').send({ ref: pinned }).expect(201);
    const id = (created.body as { manifest: { id: string } }).manifest.id;
    const res = await api().post(`/api/images/${id}/check-update`).expect(409);
    // ⚠️ 409, NOT `{changed:false}`. 「没有更新」 and 「这里没有可更新的东西」 are
    // different answers, and only the second one explains why the button did nothing
    // (P21-4 §5 ★).
    expect(expectEnvelope(res.body).code).toBe('INVALID_STATE');
  });
});

/**
 * ⭐ 「未预装」 IS A WARNING, NEVER A REASON TO HIDE THE IMAGE (04 §7 ⑥ / 10 §6.8).
 *
 * The scripted upstream declares `platform.supportedRuntimes="codex"` — honestly, and
 * that honesty used to make the platform unusable: `listSelectable` ANDed
 * `supportedRuntimes.includes(runtimeId)` into the query, so asking for the
 * `claude-code` set returned NOTHING even though the platform's only images were right
 * there. Measured on a live server before this change: 0 rows.
 *
 * Since lineage guarantees every compliant image descends from the platform base
 * (node/npm included), 「能不能装」 is settled — so refusing to OFFER the image denied a
 * capability the platform guarantees, and it hid exactly the card whose ⚠️ line exists
 * to say 「未预装，需现装约 12.5 分钟」. Preinstall status belongs in the install plan's
 * duration, not in visibility.
 */
describe('未预装 ≠ 不可选（04 §7 ⑥）', () => {
  it('an image declaring ONLY codex is still offered for claude-code', async () => {
    const forClaude = (await api().get('/api/images?runtimeId=claude-code').expect(200)).body as {
      id: string;
      ref: string;
      supportedRuntimes: string[];
    }[];
    expect(forClaude.length, '平台唯一的那些镜像不该在这里消失').toBeGreaterThan(0);
    // …and it is genuinely the honest fixture, not an image that quietly declares both.
    expect(forClaude.every((r) => !r.supportedRuntimes.includes('claude-code'))).toBe(true);
    // The two runtimes see the SAME set: selectability is `is_active` ∧ not `invalid`,
    // and nothing else.
    const forCodex = (await api().get('/api/images?runtimeId=codex').expect(200)).body as {
      id: string;
    }[];
    expect(forClaude.map((r) => r.id).sort()).toEqual(forCodex.map((r) => r.id).sort());
  });

  it('…and `?runtimeId=` still means 「只看可选集」: a retired row is absent from both', async () => {
    const created = await api()
      .post('/api/images')
      .send({ ref: 'ghcr.io/example/retire-me:1' })
      .expect(201);
    const id = (created.body as { manifest: { id: string } }).manifest.id;
    await api().patch(`/api/images/${id}`).send({ isActive: false }).expect(200);

    for (const runtimeId of ['codex', 'claude-code']) {
      const rows = (await api().get(`/api/images?runtimeId=${runtimeId}`).expect(200)).body as {
        id: string;
      }[];
      expect(rows.map((r) => r.id)).not.toContain(id);
    }
    // The management page (no `runtimeId`) still shows it — history is not deleted.
    const all = (await api().get('/api/images').expect(200)).body as { id: string }[];
    expect(all.map((r) => r.id)).toContain(id);
  });
});
