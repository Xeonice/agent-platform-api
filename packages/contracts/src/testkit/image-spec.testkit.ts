import { describe, it, expect } from 'vitest';
import {
  IMAGE_BASE_REQUIRED,
  IMAGE_TMUX_MISSING,
  OCI_DIGEST_RE,
  REF_NOT_FOUND,
  ImageSpecError,
} from '../image-spec.contract';
import type { ImageSpecManifest, ImageSpecProvider } from '../image-spec.contract';

/**
 * Golden contract suite for `ImageSpecProvider` (docs/backend/04 §10.4, IS-01..IS-05).
 * REQUIRED CI check (09 §2.3). The built-in OCI provider and any third-party one run
 * the SAME suite — no double standard.
 */
export interface ImageSpecTestCase {
  /** A ref the provider CAN resolve, plus what the registry answers for it. */
  ref: string;
  /** The digest the registry returns for `ref` — the assertion compares against THIS. */
  expectedDigest: string;
  /** A ref that does not exist ⇒ IS-02. */
  missingRef: string;
  /** A manifest whose image declares tmux and every runtime it advertises. */
  compliantManifest: ImageSpecManifest;
  /**
   * Same image, but carrying NO `platform.*` labels at all ⇒ IS-05 ①.
   *
   * ⚠️ THE EXPECTED ANSWER IS `valid: true`. The field used to be called
   * `tmuxlessManifest` and the expected answer used to be the opposite — see the
   * archived clause on the IS-05 test below.
   */
  unlabelledManifest: ImageSpecManifest;
  /** Declares a runtime the image does not preinstall ⇒ IS-05 ② (warning, still valid). */
  runtimeNotPreinstalledManifest?: ImageSpecManifest;
  /** A manifest that violates the entrypoint contract ⇒ IS-03. */
  brokenEntrypointManifest: ImageSpecManifest;
}

export function runImageSpecContractTests(
  label: string,
  factory: () => ImageSpecProvider,
  cases: ImageSpecTestCase,
): void {
  describe(`ImageSpecProvider contract: ${label}`, () => {
    it('IS-01 (MUST): a legal ref resolves to a full manifest and a REAL digest', async () => {
      const resolved = await factory().resolve(cases.ref);

      // ⚠️⚠️ THIS ASSERTION IS THE POINT OF THE WHOLE CLAUSE, AND 「non-empty」 IS NOT IT.
      // `'sha256:unresolved'` is non-empty, and it is verbatim what
      // `provision-sandbox.workflow.ts#imageSpecOf` hard-coded for the entire life of
      // this repo before the image slice (04 §7 ★). A 「digest is truthy」 check goes
      // GREEN on that exact wrong implementation — the same shape of false acceptance
      // as L-9's `git rev-list --count HEAD > 1`, which the wrong fix also satisfied.
      // So: assert the FORMAT, and assert it equals what the registry actually said.
      expect(resolved.digest).toMatch(OCI_DIGEST_RE);
      expect(resolved.digest).not.toBe('sha256:unresolved');
      expect(resolved.digest).toBe(cases.expectedDigest);

      expect(resolved.ref).toBeTruthy();
      expect(resolved.manifest.name).toBeTruthy();
      expect(resolved.manifest.version).toBeTruthy();
      expect(resolved.manifest.baseImage).toBeTruthy();
      expect(Array.isArray(resolved.manifest.supportedRuntimes)).toBe(true);
      // ⚠️ `diffIds` MUST BE NON-EMPTY, NOT MERELY AN ARRAY. `[]` is a prefix of every
      // possible image, so an anchor with empty `diff_ids` would make the lineage rule
      // admit everything — present, and never rejecting anything. `isDerivedFrom`
      // refuses an empty base for that reason; this clause stops a provider from
      // shipping the empty value in the first place.
      expect(Array.isArray(resolved.manifest.diffIds)).toBe(true);
      expect(resolved.manifest.diffIds.length).toBeGreaterThan(0);
      expect(typeof resolved.manifest.resourceDefaults.cores).toBe('number');
      expect(Array.isArray(resolved.manifest.entrypointContract.entrypoint)).toBe(true);
      // `resolvedAt` is what makes 「上游有新版本」 and the compare drawer renderable
      // (P21-4 §5); a manifest without it degrades the card to a bare 「N 小时前」.
      expect(Number.isNaN(Date.parse(resolved.resolvedAt))).toBe(false);
    });

    it('IS-02 (MUST): a ref that does not exist throws REF_NOT_FOUND', async () => {
      await expect(factory().resolve(cases.missingRef)).rejects.toMatchObject({
        code: REF_NOT_FOUND,
      });
      // …and it is the typed contract error, not a bare Error with a `code` bolted on:
      // the interface layer maps `ImageSpecError` to HTTP, and anything else lands as
      // an envelope-less 500.
      await factory()
        .resolve(cases.missingRef)
        .then(
          () => expect.unreachable('resolve() must reject for a missing ref'),
          (e: unknown) => expect(e).toBeInstanceOf(ImageSpecError),
        );
    });

    it('IS-03 (MUST): an entrypoint-contract violation yields errors WITH a path', () => {
      const result = factory().validate(cases.brokenEntrypointManifest);
      expect(result.valid).toBe(false);
      // 「不接受只给 `valid:false`」 — a bare boolean cannot be rendered next to the
      // offending field, which is the entire product promise of 三级反馈 (P21-4 §5).
      expect(result.errors.length).toBeGreaterThan(0);
      for (const err of result.errors) {
        expect(typeof err.code).toBe('string');
        expect(err.code).not.toBe('');
        expect(typeof err.message).toBe('string');
        expect(err.path, `error ${err.code} must be locatable`).toBeTruthy();
      }
    });

    it('IS-04 (MUST): validate() is a pure judgement — frozen input, no throw', () => {
      const provider = factory();
      const frozen = deepFreeze(structuredClone(cases.compliantManifest));
      const before = JSON.stringify(frozen);
      expect(() => provider.validate(frozen)).not.toThrow();
      // A mutation attempt on a frozen object throws in strict mode (all TS output is
      // strict), so `not.toThrow()` already covers 「不修改入参」 — the stringify pins
      // the same fact for any non-strict consumer and reads as the explicit assertion.
      expect(JSON.stringify(frozen)).toBe(before);
    });

    it('IS-05 (MUST): validate() judges the SPEC only — no tmux verdict, no lineage verdict', () => {
      const result = factory().validate(cases.unlabelledManifest);

      // ── 现在的口径 ────────────────────────────────────────────────────────────
      // `validate()` owns exactly two things: the ENTRYPOINT CONTRACT (errors, IS-03)
      // and 「哪些 runtime 没预装」 (warnings, IS-05 ② below). An image that declares no
      // `platform.*` label is NOT thereby invalid: labels are INHERITED, so on a
      // derived image a label neither proves nor disproves anything (measured: a
      // derived image with zero `platform.*` lines of its own reported all three of its
      // base's). The two verdicts that replaced it are elsewhere on purpose:
      //   · 血统 (`diffIds` 前缀) — needs to know which bases the platform registered,
      //     i.e. DATABASE state; putting it here would break IS-04's 「纯判断」 and
      //     would force every third-party SPI to enforce the platform's own policy;
      //   · tmux 实测 (`command -v tmux`) — a fact about a live sandbox, not metadata.
      expect(result.valid, 'an unlabelled but well-formed image is a valid SPEC').toBe(true);
      const codes = result.errors.map((e) => e.code);
      // ⚠️ ASSERT THE ABSENCE BY CODE, NOT JUST `valid:true`. An implementation that
      // still emitted `IMAGE_TMUX_MISSING` — as a warning, say — would keep the old,
      // inherited-and-therefore-meaningless judgement alive in the UI while this
      // clause stayed green on the boolean alone.
      expect(codes, 'tmux is no longer validate()’s business').not.toContain(IMAGE_TMUX_MISSING);
      expect([...codes, ...(result.warnings ?? []).map((w) => w.code)]).not.toContain(
        IMAGE_TMUX_MISSING,
      );
      // …and lineage is not either: `validate(manifest)` cannot know what the platform
      // has registered, so a provider that answered this would be guessing.
      expect(codes, 'lineage is an application-layer policy, not a spec judgement').not.toContain(
        IMAGE_BASE_REQUIRED,
      );

      // ── 原条款（存档，勿当现状读）─────────────────────────────────────────────
      // 2026-08 之前本条断言的是它的**反面**：
      //     const result = factory().validate(cases.tmuxlessManifest);
      //     expect(result.valid).toBe(false);
      //     expect(result.errors.map((e) => e.code)).toContain(IMAGE_TMUX_MISSING);
      // 那一版配套的是「注册期靠 `platform.tmux` 标签声明判合规」。它被两件事推翻：
      //   ① 平台连自己依赖的上游镜像都注册不了 —— `ghcr.io/agent-infra/sandbox` 是
      //      第三方镜像，不会打我们发明的 `platform.*` 标签，于是被判 MANIFEST_INVALID；
      //   ② 标签会被派生镜像继承，所以它在派生场景里不但证明不了什么，还会主动说谎
      //      （`RUN rm /usr/bin/tmux` 之后仍继承 `platform.tmux=true`）。
      // 与 SHOULD→MUST 那次一样，这条**整条改写而不是删掉**：删掉会让「缺 tmux 该怎么判」
      // 变成没人守的空白，而照抄旧断言会**反向**判定——它会让一个正确的实现变红。
      // 存档口径见 04 §10.4 IS-05 的「原条款」两段。
    });

    const warnCase = cases.runtimeNotPreinstalledManifest;
    if (warnCase) {
      it('IS-05 ② (MUST): a genuinely non-fatal finding is a WARNING, not an error', () => {
        const result = factory().validate(warnCase);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
        expect((result.warnings ?? []).length).toBeGreaterThan(0);
      });
    } else {
      describe.skip('IS-05 ② SKIPPED — no `runtimeNotPreinstalledManifest` supplied', () => {
        it('a genuinely non-fatal finding is a WARNING, not an error', () => undefined);
      });
    }
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
