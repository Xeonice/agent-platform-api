import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  IMAGE_ENTRYPOINT_INVALID,
  IMAGE_LABEL_RESOURCE_DEFAULTS,
  IMAGE_LABEL_SUPPORTED_RUNTIMES,
  IMAGE_LABEL_TMUX,
  RUNTIME_ADAPTER_REGISTRY,
  RUNTIME_NOT_PREINSTALLED,
  formatImageRef,
  parseImageRef,
} from '@platform/contracts';
import type {
  ImageSpecManifest,
  ImageSpecProvider,
  ResolvedImage,
  ValidationIssue,
  ValidationResult,
} from '@platform/contracts';
import { CLOCK } from '@platform/shared-kernel';
import type { Clock } from '@platform/shared-kernel';
import { OciRegistryClient } from './oci-registry.client';

/**
 * Built-in `ImageSpecProvider` over the OCI Distribution API (docs/backend/04 §7).
 *
 * `resolve()` is the ONLY place in the platform that turns a tag into a digest, and
 * it runs at exactly two user-initiated moments (registration and re-validation).
 * `validate()` never touches the network at all.
 */

/** Platform scheduler fallbacks when the image declares none (03 §1). */
const DEFAULT_RESOURCE_DEFAULTS = { cores: 2, ramMb: 2048, diskMb: 10240 };

/**
 * The platform-contract labels this provider REPORTS as declared (04 §7 ★血统).
 *
 * ⚠️ 「REPORTS」, NOT 「REQUIRES」 — the word changed in 2026-08 and so did the job.
 * `validate()` no longer rejects an image for missing `platform.tmux`; the only reader
 * of the reported list is the image module's application layer, and only for the ROOT
 * image (`builtin: true`). Labels are inherited by derived images, so on anything but
 * the root the list describes the ANCESTOR, not the image in hand.
 */
const REPORTED_LABELS = [IMAGE_LABEL_TMUX];

/** `org.opencontainers.image.base.name` is the standard「built FROM」declaration. */
const OCI_BASE_NAME_LABEL = 'org.opencontainers.image.base.name';

/**
 * The ONLY thing this provider needs from the runtime adapter registry: which runtime
 * ids exist. `RuntimeAdapterRegistry` satisfies it structurally, so DI is unchanged —
 * but a test can supply two ids without constructing two full adapters, and the
 * narrower type says out loud that nothing here drives an adapter.
 */
interface RuntimeIdSource {
  list(): readonly { readonly id: string }[];
}

@Injectable()
export class OciImageSpecProvider implements ImageSpecProvider {
  readonly name = 'oci';
  private readonly client: OciRegistryClient;

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    /**
     * Optional: the warning half of IS-05 asks 「which runtimes does this image NOT
     * preinstall」, and only the adapter registry knows what runtimes exist. Marked
     * `@Optional` so a standalone contract test can construct the provider without
     * booting the runtime module — with no registry there are simply no warnings,
     * never a wrong one.
     */
    @Optional()
    @Inject(RUNTIME_ADAPTER_REGISTRY)
    private readonly runtimes?: RuntimeIdSource,
    /**
     * Injection seam for the contract tests: they hand in a client backed by a
     * fixture registry so IS-01..IS-05 run with no network at all. `@Optional` is
     * mandatory rather than tidy — without it Nest sees the emitted parameter type
     * and tries to resolve `OciRegistryClient` from the module, which is not a
     * provider (it is a plain class the provider news up).
     */
    @Optional() client?: OciRegistryClient,
  ) {
    this.client = client ?? new OciRegistryClient(registryTimeoutMs());
  }

  async resolve(ref: string): Promise<ResolvedImage> {
    const parsed = parseImageRef(ref);
    const reference = parsed.digest ?? parsed.tag ?? 'latest';
    const fetched = await this.client.fetchManifest(parsed.name, reference);
    const cfg = fetched.config.config ?? {};
    const labels = cfg.Labels ?? {};

    const manifest: ImageSpecManifest = {
      name: parsed.name,
      version: reference,
      baseImage: labels[OCI_BASE_NAME_LABEL] ?? formatImageRef(parsed.name, reference),
      entrypointContract: {
        workdir: cfg.WorkingDir !== undefined && cfg.WorkingDir !== '' ? cfg.WorkingDir : '/',
        // `Entrypoint` may be absent on an image that only sets `Cmd` — both are
        // legal ways to say 「this is how you start me」, and reading only the first
        // would report a perfectly good image as having no entry point.
        entrypoint: cfg.Entrypoint ?? cfg.Cmd ?? [],
        healthcheckCmd: cfg.Healthcheck?.Test,
      },
      supportedRuntimes: parseRuntimes(labels[IMAGE_LABEL_SUPPORTED_RUNTIMES]),
      resourceDefaults: parseResourceDefaults(labels[IMAGE_LABEL_RESOURCE_DEFAULTS]),
      /**
       * ⚠️ READ THIS FIELD AS 「the platform-contract labels this image DECLARES」ONLY.
       * It is a self-report, and since labels are INHERITED it is a self-report that a
       * derived image did not necessarily write. Its one consumer is the root-image
       * check at registration; nothing downstream may read it as evidence about the
       * bits (that job belongs to `diffIds` and to the runtime probe).
       */
      labelsRequired: REPORTED_LABELS.filter((l) => labels[l] === 'true'),
      /**
       * ⚠️ THE ONE FACT ON THIS MANIFEST THAT CANNOT BE FAKED BY A LABEL. It comes from
       * the config blob we already fetched — no extra request, no layer pulled — and it
       * is what registration verifies lineage against (04 §7 ★血统).
       *
       * An image whose config carries no `rootfs.diff_ids` degrades to `[]`, which
       * `isDerivedFrom` treats as 「not an anchor and not derivable」 — i.e. it FAILS
       * closed. Silently passing an image we cannot describe would delete the rule.
       */
      diffIds: fetched.config.rootfs?.diff_ids ?? [],
    };

    return {
      ref: formatImageRef(parsed.name, reference),
      digest: fetched.digest,
      entrypoint: manifest.entrypointContract.entrypoint,
      manifest,
      resolvedAt: this.clock.now().toISOString(),
    };
  }

  /**
   * Pure judgement — no IO, no mutation of `manifest` (testkit IS-04).
   *
   * ⚠️ ITS SCOPE IS THE IMAGE SPEC: the entry-point contract (errors) and which
   * runtimes the image says it preinstalls (warnings). NOTHING ELSE.
   *
   * ⚠️ THE tmux BRANCH THAT USED TO LIVE HERE WAS DELETED IN 2026-08, AND IT WAS NOT
   * A RELAXATION. It read 「`labelsRequired` 不含 `platform.tmux` ⇒ `valid:false` +
   * `IMAGE_TMUX_MISSING`」, and it was wrong in two directions at once:
   *   · it refused the platform's OWN upstream dependency — `ghcr.io/agent-infra/
   *     sandbox` is a third-party image and will never carry a label we invented;
   *   · on a DERIVED image it was worse than useless, because labels are inherited: an
   *     image that does `RUN rm /usr/bin/tmux` keeps advertising `platform.tmux=true`.
   * Compliance moved to the two things that cannot be inherited-and-wrong — lineage
   * (`diffIds`, verified at registration by the application layer) and the live
   * `command -v tmux` (verified at `bootstrapAgentSession`).
   *
   * ⚠️ AND LINEAGE DELIBERATELY DID NOT MOVE IN HERE. It needs to know which base
   * images the platform has registered — database state — and `validate(manifest)` is
   * contractually a pure, side-effect-free, re-runnable judgement over its one
   * argument (IS-04). See `image-application.service.ts#assertLineage`.
   */
  validate(manifest: ImageSpecManifest): ValidationResult {
    const errors: ValidationIssue[] = [];
    const warnings: Array<{ code: string; message: string }> = [];

    // Entry-point contract (IS-03). Every error carries a `path` — a bare
    // `valid:false` cannot be rendered next to the field it is about, and 三级反馈 is
    // the whole product promise of this screen (P21-4 §5).
    if (manifest.entrypointContract.entrypoint.length === 0) {
      errors.push({
        code: IMAGE_ENTRYPOINT_INVALID,
        path: 'entrypointContract.entrypoint',
        message: '镜像既没有 Entrypoint 也没有 Cmd，平台无法启动它。',
      });
    }
    if (manifest.entrypointContract.workdir === '') {
      errors.push({
        code: IMAGE_ENTRYPOINT_INVALID,
        path: 'entrypointContract.workdir',
        message: '镜像没有声明工作目录（WorkingDir）。',
      });
    }

    for (const runtimeId of this.knownRuntimes()) {
      if (manifest.supportedRuntimes.includes(runtimeId)) continue;
      warnings.push({
        code: RUNTIME_NOT_PREINSTALLED,
        message:
          `镜像未声明预装 '${runtimeId}'（${IMAGE_LABEL_SUPPORTED_RUNTIMES}）。` +
          '选用该 runtime 时会在沙箱内现装，实测可能需要数分钟而不是数秒。',
      });
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  private knownRuntimes(): string[] {
    try {
      return (this.runtimes?.list() ?? []).map((r) => r.id);
    } catch {
      return [];
    }
  }
}

function registryTimeoutMs(): number {
  const raw = Number(process.env.IMAGE_REGISTRY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

function parseRuntimes(label: string | undefined): string[] {
  if (label === undefined) return [];
  return label
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function parseResourceDefaults(label: string | undefined): {
  cores: number;
  ramMb: number;
  diskMb: number;
} {
  if (label === undefined) return { ...DEFAULT_RESOURCE_DEFAULTS };
  try {
    const parsed: unknown = JSON.parse(label);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_RESOURCE_DEFAULTS };
    const rec = parsed as Record<string, unknown>;
    return {
      cores: num(rec.cores, DEFAULT_RESOURCE_DEFAULTS.cores),
      ramMb: num(rec.ramMb, DEFAULT_RESOURCE_DEFAULTS.ramMb),
      diskMb: num(rec.diskMb, DEFAULT_RESOURCE_DEFAULTS.diskMb),
    };
  } catch {
    // A malformed label is NOT a registration failure: resource defaults have a
    // platform fallback, and refusing an otherwise good image over a typo in an
    // optional label would be the platform being precious about its own convenience.
    return { ...DEFAULT_RESOURCE_DEFAULTS };
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}
