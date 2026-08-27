import type { ResolvedImageSpec } from './sandbox-provider.contract';

/**
 * ImageSpec contract (docs/backend/04 §7) — the third registrable extension point
 * next to `SandboxProvider` and `RuntimeAdapter` (04 §8). Its two methods split
 * cleanly by WHEN they run and WHAT they may touch:
 *
 *   - `resolve(ref)` goes to the network. It pins whatever the user typed (tag /
 *     digest / alias) to an IMMUTABLE coordinate. It is called at exactly TWO
 *     moments (04 §7「resolve 到底在哪一步被调用」): registration
 *     (`POST /api/images`) and re-validation (`POST /api/images/:id/validate`).
 *     **It is never called at the create door** — a network call there would
 *     introduce `REGISTRY_UNREACHABLE` (retryable:true) into a door whose every
 *     rejection is retryable:false by construction (10 §6.8).
 *   - `validate(manifest)` is a PURE judgement: no mutation of its input, no IO,
 *     no side effects (testkit IS-04), so it can be re-run freely outside a
 *     transaction.
 */

/** Scheduler input (03 §1). Declared by the image, never typed by a user. */
export interface ResourceDefaults {
  cores: number;
  ramMb: number;
  diskMb: number;
}

/** How the platform is expected to enter the image (04 §7 「入口约定」). */
export interface EntrypointContract {
  workdir: string;
  entrypoint: string[];
  healthcheckCmd?: string[];
}

export interface ImageSpecManifest {
  name: string;
  version: string;
  baseImage: string;
  entrypointContract: EntrypointContract;
  supportedRuntimes: string[];
  resourceDefaults: ResourceDefaults;
  labelsRequired?: string[];
  /**
   * `rootfs.diff_ids` from the image config blob — the ordered hashes of every
   * UNCOMPRESSED layer. This is the platform's LINEAGE ANCHOR (04 §7 ★血统).
   *
   * ⚠️ WHY THIS AND NOT THE MANIFEST DIGEST. A manifest digest hashes the COMPRESSED
   * blobs; mirroring an image into an internal registry recompresses it and mints a
   * new digest for byte-identical content. `diff_ids` hash the uncompressed content,
   * so they survive the mirror — which is the difference between a lineage rule that
   * works in a real deployment and one that only works on the machine that built it.
   *
   * ⚠️ AND IT COSTS NOTHING. `resolve()` already fetches the config blob to read
   * `Labels`; `rootfs.diff_ids` is in the same few KB of JSON. No layer is pulled
   * (04 §3「只做元数据解析，不拉层数据」).
   *
   * Required, not optional, because it now HAS a reader (`isDerivedFrom`, called at
   * registration) — 04 §8 取舍① objects to a required field with no reader, and this
   * one has one.
   */
  diffIds: string[];
}

/** One locatable finding. `path` is required on errors (testkit IS-03). */
export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings?: Array<{ code: string; message: string }>;
}

/**
 * What `resolve()` returns: the run-time projection (`ResolvedImageSpec`) PLUS the
 * registration-time half.
 *
 * ⚠️ WHY THIS IS A SEPARATE TYPE AND NOT TWO MORE REQUIRED FIELDS ON
 * `ResolvedImageSpec`. 04 §7's 目标形态 block draws one type carrying all five
 * fields, and structurally this IS that type — `ResolvedImage` is assignable to
 * `ResolvedImageSpec` everywhere. The split is about who READS what:
 * `provider.create()` and `getInstallPlan()` take a `ResolvedImageSpec` and read
 * `ref` / `digest` / `entrypoint`; neither has ever read a manifest. Making
 * `manifest` + `resolvedAt` required on the type those two consume would force
 * every call site that provably does not read them — the adapters' documented
 * `ANY_IMAGE` neutral spec, and every provider e2e that builds a context by hand —
 * to invent filler. That is precisely 04 §8 取舍① 's 「一个没有读者的必填字段」,
 * and it is the reason 04 §7 itself gave for leaving them off until now. So the
 * two fields land on the type that HAS a reader (the image aggregate, built at
 * registration), and the run-time type stays exactly as wide as its readers.
 */
export interface ResolvedImage extends ResolvedImageSpec {
  manifest: ImageSpecManifest;
  /** ISO instant of THIS resolution — the freshness half of P21-4 §5's card. */
  resolvedAt: string;
}

export interface ImageSpecProvider {
  readonly name: string;
  /**
   * Pin `ref` to an immutable coordinate + manifest. MUST produce a real digest
   * (testkit IS-01) — `'sha256:unresolved'` is the exact failure this contract
   * exists to delete (04 §7 ★).
   *
   * @throws ImageSpecError `REF_NOT_FOUND` (IS-02) / `REGISTRY_UNREACHABLE`
   */
  resolve(ref: string): Promise<ResolvedImage>;
  /**
   * Pure judgement; MUST NOT mutate `manifest` and MUST NOT perform IO (IS-04).
   *
   * ⚠️ ITS SCOPE IS THE IMAGE SPEC, NOT PLATFORM ADMISSION POLICY (testkit IS-05).
   * It judges the ENTRYPOINT CONTRACT (errors) and which runtimes the image says it
   * preinstalls (warnings). It does NOT judge lineage — 「is this built on a platform
   * base image」 needs to know WHICH bases the platform has registered, i.e. database
   * state, and a `validate(manifest)` that reads the database is no longer the pure,
   * re-runnable judgement IS-04 requires. Lineage is enforced in the image module's
   * application layer, at registration.
   *
   * ⚠️ AND THAT SPLIT IS ALSO ABOUT WHOSE POLICY IT IS. `ImageSpecProvider` is a
   * replaceable SPI (`registry-extension.e2e` swaps in a third-party one); putting the
   * platform's own admission rule inside it would require every third-party
   * implementation to enforce a policy that is not theirs.
   */
  validate(manifest: ImageSpecManifest): ValidationResult;
}

/**
 * Open registry for image-spec providers (04 §8 方式一), mirroring
 * `ProviderRegistry`. Third-party modules inject `IMAGE_SPEC_REGISTRY` and call
 * `register()` from their own `onModuleInit` — no platform-side factory, one
 * registration path, one uniqueness check.
 */
export interface ImageSpecRegistry {
  register(impl: ImageSpecProvider, opts?: { default?: boolean }): void;
  get(name: string): ImageSpecProvider;
  has(name: string): boolean;
  list(): ImageSpecProvider[];
  readonly defaultProvider: string;
}

// ── error codes (shared/10 §6.8) ────────────────────────────────────────────────

/** The ref does not exist in the registry (404, 零副作用). testkit IS-02. */
export const REF_NOT_FOUND = 'REF_NOT_FOUND';
/**
 * The registry could not be reached (502, retryable). ⚠️ The ONLY retryable code in
 * the image group, and the reason `resolve` is banned from the create door.
 */
export const REGISTRY_UNREACHABLE = 'REGISTRY_UNREACHABLE';
/**
 * Registration refused the image → the manifest is NOT stored (422).
 *
 * ⚠️ IT COVERS BOTH REGISTRATION-TIME VERDICTS, NOT ONLY `validate()`'s. The
 * spec-level judgement (`IMAGE_ENTRYPOINT_INVALID`) and the platform's admission
 * policy (`IMAGE_BASE_REQUIRED`, `IMAGE_TMUX_MISSING` on the root) land under the same
 * top-level code because the user does the same thing about both — fix the image and
 * submit again — and the specific reason is already in `details[]`.
 */
export const MANIFEST_INVALID = 'MANIFEST_INVALID';
/**
 * The ROOT image does not DECLARE tmux (04 §7 ★血统, testkit IS-05 存档条款).
 *
 * ⚠️ ITS SCOPE NARROWED IN 2026-08 AND THE NARROWING IS THE POINT. It used to be
 * `validate()`'s verdict on EVERY image. It is now produced only by the image
 * module's application layer, and only for the ROOT image — the one the operator
 * names in `SANDBOX_DEFAULT_IMAGE` and the seeder registers with `builtin: true`.
 *
 * Why it does not apply to derived images: labels are INHERITED. A derived image that
 * does `RUN rm /usr/bin/tmux` still carries `platform.tmux=true` from its base
 * (measured: a derived image declaring no `platform.*` at all reported all three of
 * its base's). So on a derived image the label cannot prove anything AND actively
 * lies. What CAN be proved there is lineage (`diffIds` prefix), and lineage plus 「the
 * platform built its own base」 is what carries tmux forward.
 *
 * On the ROOT it is still worth asking, for a different job: it catches 「the operator
 * pointed `SANDBOX_DEFAULT_IMAGE` at the wrong image」 at boot. It is a DECLARATION by
 * the operator about an image the operator chose — not a defence against lying, which
 * remains the runtime `command -v tmux`.
 *
 * ⚠️ IT IS A `details[].code`, NEVER A TOP-LEVEL `code` (10 §6.8). It rides inside
 * `ValidationOutcome.errors[]` and, over the wire, inside the envelope's `details[]`
 * under a top-level `MANIFEST_INVALID` (422).
 *
 * ⚠️ AND IT IS NOT `IMAGE_CONTRACT_VIOLATION`. That one is the RUNTIME verdict
 * (`command -v tmux` missed inside a live sandbox ⇒ the instance fails, over WS).
 * This one is the REGISTRATION verdict. 「注册期拦住的是不声明，运行期拦住的是谎报」
 * — two moments, two codes, neither substitutable.
 */
export const IMAGE_TMUX_MISSING = 'IMAGE_TMUX_MISSING';
/**
 * A user-supplied image is not built on any platform base image (04 §7 ★血统).
 *
 * ⚠️ A `details[].code` under `MANIFEST_INVALID` (422), exactly like
 * `IMAGE_TMUX_MISSING` — the top-level code stays 「this image was not accepted」 and
 * the reason rides in `details[]`, which is what the ❌ card renders line by line
 * (P21-4 §5). A new TOP-LEVEL code would need a new copy entry in the frontend table
 * and would say nothing the detail line does not.
 *
 * ⚠️ IT IS NOT THE CODE FOR 「平台一张预制镜像都没有」. That case is the PLATFORM not
 * being ready, not the user's image being wrong; telling the user to rebuild their
 * Dockerfile would send them to fix something that is not broken. It surfaces as
 * `INVALID_STATE` (409, C 类「请求没错但此刻不行」) instead.
 */
export const IMAGE_BASE_REQUIRED = 'IMAGE_BASE_REQUIRED';
/**
 * The image declares no usable entry (no `Entrypoint`/`Cmd`, or no `WorkingDir`).
 * `validate()`'s 入口约定 half — testkit IS-03 asks for a locatable `path`, so this
 * one code carries a different `path` per offending field rather than splitting into
 * a code per field: the user's action is the same (fix the Dockerfile), and a code
 * per field would be a code table that grows with the manifest shape.
 */
export const IMAGE_ENTRYPOINT_INVALID = 'IMAGE_ENTRYPOINT_INVALID';
/**
 * A runtime the platform offers that this image does not declare as preinstalled
 * (IS-05 ②). A WARNING, never an error: 现装 works, it just costs minutes instead of
 * seconds (a cold `npm i -g @anthropic-ai/claude-code` was measured at 753s).
 *
 * ⚠️ AND IT MUST NOT GATE SELECTABILITY EITHER — that was the second half of the same
 * mistake. Lineage guarantees the image carries the base's node/npm, so ANY compliant
 * image CAN install ANY runtime; refusing to offer the image for a runtime it merely
 * has not preinstalled denies a capability the platform already guarantees, and it
 * hides the very card whose ⚠️ line says 「未预装，需现装约 12.5 分钟」. Measured: with
 * an honest `platform.supportedRuntimes="codex"`, `GET /api/images?runtimeId=
 * claude-code` returned ZERO images — on a platform whose only image was that one.
 */
export const RUNTIME_NOT_PREINSTALLED = 'RUNTIME_NOT_PREINSTALLED';

export type ImageSpecErrorCode = typeof REF_NOT_FOUND | typeof REGISTRY_UNREACHABLE;

/** Boundaries-safe error the infra provider throws and the interface maps to HTTP. */
export class ImageSpecError extends Error {
  constructor(
    readonly code: ImageSpecErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ImageSpecError';
  }

  /** `REGISTRY_UNREACHABLE` is transport; `REF_NOT_FOUND` is a fact about the ref. */
  get retryable(): boolean {
    return this.code === REGISTRY_UNREACHABLE;
  }
}

// ── image labels (04 §7 ★血统：标签只驱动 warning 与根镜像声明) ──────────────────

/**
 * `resolve()` can only see the manifest + config blob (`Env` / `Entrypoint` / `Cmd` /
 * `Labels` / `User` / `WorkingDir` / `rootfs`). It CANNOT see whether
 * `/usr/bin/tmux` exists, and the two ways to find out are both closed: pulling
 * layers violates 04 §3 (「只做元数据解析，不拉层数据」), and booting a container to
 * run `command -v tmux` cannot fit the 60s validate budget for a 3.3GB image
 * (P21-4 §6).
 *
 * ⚠️ WHAT CHANGED IN 2026-08: THESE LABELS ARE NO LONGER THE COMPLIANCE VERDICT.
 * Labels are INHERITED by every derived image, so on a derived image a label neither
 * proves anything nor stays true — a derived image that deletes tmux still advertises
 * `platform.tmux=true`. So the labels now drive exactly two things:
 *
 *   · `platform.tmux` on the ROOT image only — an operator DECLARATION that catches
 *     「指错了镜像」 at boot (`IMAGE_TMUX_MISSING`);
 *   · `platform.supportedRuntimes` — a WARNING (`RUNTIME_NOT_PREINSTALLED`) and the
 *     install-plan hint. Never a rejection: 现装 always works.
 *
 * The COMPLIANCE verdict moved to two things that cannot be inherited-and-wrong:
 * lineage at registration (`diffIds`, verifiable) and `command -v tmux` at runtime
 * (a fact about the live sandbox).
 */
export const IMAGE_LABEL_TMUX = 'platform.tmux';
export const IMAGE_LABEL_SUPPORTED_RUNTIMES = 'platform.supportedRuntimes';
export const IMAGE_LABEL_RESOURCE_DEFAULTS = 'platform.resourceDefaults';

/**
 * Is `candidate` built ON TOP OF `base`? (04 §7 ★血统, 注册期的可验证事实)
 *
 * A derived image's `rootfs.diff_ids` are its base's diff_ids VERBATIM, in order,
 * followed by whatever the derived Dockerfile added. So 「基于」 is exactly 「前缀」.
 * Equality counts as derivation: `LABEL` / `ENV` / `CMD` add no layer at all, so a
 * legitimate `FROM base` + `LABEL …` image has diff_ids IDENTICAL to its base
 * (measured — 77 layers vs 77, and the 78-layer `RUN` case shares the first 77).
 *
 * ⚠️ AN EMPTY `base` IS NEVER AN ANCHOR, AND THAT GUARD IS LOAD-BEARING. `[]` is a
 * prefix of everything, so an anchor whose `diff_ids` could not be read would silently
 * admit every image on earth — the rule would still be there, just never rejecting
 * anything. A base we cannot describe is not a base.
 */
export function isDerivedFrom(candidate: readonly string[], base: readonly string[]): boolean {
  if (base.length === 0) return false;
  if (candidate.length < base.length) return false;
  return base.every((layer, i) => candidate[i] === layer);
}

/** `sha256:` + 64 lowercase hex. testkit IS-01 asserts THIS, never 「non-empty」. */
export const OCI_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export function isOciDigest(value: string): boolean {
  return OCI_DIGEST_RE.test(value);
}

/**
 * The string a provider must actually pull (04 §7 时刻④).
 *
 * ⚠️ THIS FUNCTION IS THE WHOLE POINT OF FREEZING A DIGEST. Steps ①②③ pin a
 * coordinate into the database; if step ④ still hands `provider.create()` a bare
 * tag, all three were bookkeeping — 04 §7's 「不可变坐标」这件事，只在最后交给
 * provider 的那个字符串是 digest 时才成立.
 *
 * A ref that already carries `@sha256:` is returned untouched (double-pinning is
 * not a thing), and a spec whose `digest` is not a real digest degrades to the tag
 * rather than producing an unpullable `img:tag@sha256:unresolved`.
 */
export function pinnedImageRef(spec: Pick<ResolvedImageSpec, 'ref' | 'digest'>): string {
  if (spec.ref.includes('@')) return spec.ref;
  if (!isOciDigest(spec.digest)) return spec.ref;
  return `${spec.ref}@${spec.digest}`;
}

// ── OCI reference parsing (shared by the registry client and the image aggregate) ──

export interface ParsedImageRef {
  /** Everything before the tag/digest — registry host included (`ghcr.io/a/b`). */
  name: string;
  /** Present for a tag-form ref. Mutually exclusive with `digest` in the INPUT. */
  tag?: string;
  /** Present for a digest-form ref (`…@sha256:…`) — already pinned, cannot drift. */
  digest?: string;
}

/**
 * Split `name[:tag][@digest]`.
 *
 * ⚠️ THE COLON SEARCH MUST START AFTER THE LAST `/`. `localhost:5001/img` has a colon
 * in the REGISTRY HOST, and reading that as a tag turns the whole reference into
 * `localhost` + tag `5001/img` — a name that resolves to a completely different image
 * on Docker Hub. The local `:5001` mirror this repo's boxlite e2e depends on is
 * exactly that shape, so the bug would be silent everywhere except where it matters.
 */
export function parseImageRef(ref: string): ParsedImageRef {
  const at = ref.indexOf('@');
  if (at >= 0) return { name: ref.slice(0, at), digest: ref.slice(at + 1) };
  const lastSlash = ref.lastIndexOf('/');
  const colon = ref.indexOf(':', lastSlash + 1);
  if (colon < 0) return { name: ref, tag: 'latest' };
  return { name: ref.slice(0, colon), tag: ref.slice(colon + 1) };
}

/** Rebuild a coordinate from the pieces the DB stores (`images.name` + `version`). */
export function formatImageRef(name: string, reference: string): string {
  return isOciDigest(reference) ? `${name}@${reference}` : `${name}:${reference}`;
}
