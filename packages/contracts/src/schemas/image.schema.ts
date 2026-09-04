import { z } from 'zod';
import { IsoInstantSchema } from './primitives';

/**
 * Image wire contracts (docs/backend/27 §6, shared/10 §6.4, 13 §2.4).
 * ONE zod source produces the REST DTO and the OpenAPI reflection.
 *
 * SECURITY (23 I-IMG-5): `secret: true` env values are NEVER echoed. Outbound they
 * are an empty string; inbound an empty string means 「保持不变」, not 「清空」 —
 * the two directions agree on the same sentinel on purpose, so a round-trip of a
 * masked form is a no-op instead of a silent wipe.
 */

/** `pending` before the first validate; the other three are the 三级反馈 (P21-4 §5). */
export const IMAGE_VALIDATION_STATUSES = ['pending', 'valid', 'warning', 'invalid'] as const;
export const ImageValidationStatusSchema = z.enum(IMAGE_VALIDATION_STATUSES);
export type ImageValidationStatus = z.infer<typeof ImageValidationStatusSchema>;

/** One locatable finding. `path` points AT the offending item (`env[3].key`). */
export const ValidationIssueSchema = z.object({
  path: z.string().optional(),
  code: z.string(),
  message: z.string(),
});
export type ValidationIssueDto = z.infer<typeof ValidationIssueSchema>;

/**
 * 三级 (not two): a `warning` image is still SELECTABLE, with its consequence spelled
 * out next to the option (P21-4 §9). Collapsing it to a boolean would delete the only
 * state that says 「能用，但你该知道这件事」.
 */
export const ValidationOutcomeSchema = z.object({
  status: ImageValidationStatusSchema,
  errors: z.array(ValidationIssueSchema),
  warnings: z.array(ValidationIssueSchema),
});
export type ValidationOutcomeDto = z.infer<typeof ValidationOutcomeSchema>;

/** Outbound env entry — `value` is `''` whenever `secret` (I-IMG-5). */
export const ImageEnvVarSchema = z.object({
  key: z.string(),
  value: z.string(),
  secret: z.boolean(),
});
export type ImageEnvVarDto = z.infer<typeof ImageEnvVarSchema>;

export const ImageConfigSchema = z.object({
  env: z.array(ImageEnvVarSchema),
  /** MVP: read-only display; editable in v1.1 (13 §2.4.3). */
  cmdOverride: z.array(z.string()).optional(),
});
export type ImageConfigDto = z.infer<typeof ImageConfigSchema>;

/**
 * Inbound env entry. `secret` defaults to false; an empty `value` on a secret means
 * 「keep the stored ciphertext」 (23 I-IMG-5) — the app layer skips the overwrite
 * rather than writing an empty secret.
 *
 * ⚠️ NO LENGTH/NAME RULES HERE ON PURPOSE. The authority for those six rules is the
 * `EnvVarSet` value object (23 §9.3, 构造即校验) — it is the ONE implementation shared
 * by the image / project / task layers. Restating them in zod would create a second
 * source that drifts, and the shape they need to produce (`ENV_NAME_RESERVED` &c. in
 * `details[].code`) is not a shape zod issues can carry.
 */
export const ImageEnvVarInputSchema = z.object({
  key: z.string(),
  value: z.string(),
  secret: z.boolean().optional(),
});
export const ImageConfigInputSchema = z.object({
  env: z.array(ImageEnvVarInputSchema),
  cmdOverride: z.array(z.string()).optional(),
});
export type ImageConfigInput = z.infer<typeof ImageConfigInputSchema>;

export const EntrypointContractSchema = z.object({
  workdir: z.string(),
  entrypoint: z.array(z.string()),
  healthcheckCmd: z.array(z.string()).optional(),
});

export const ResourceDefaultsSchema = z.object({
  cores: z.number(),
  ramMb: z.number(),
  diskMb: z.number(),
});

/**
 * `ImageManifestDto` — 27 §6 `listImages` pins the required set explicitly:
 * `digest` / `resolvedAt` / `imageId` / `imageName` / `version` / `isActive` /
 * `validationStatus` / `validationErrors` / `supportedRuntimes` / `imageConfig` /
 * `isBuiltin`.
 *
 * ⚠️ `digest` + `resolvedAt` ARE NOT DECORATION. Without them the card falls back to
 * 「最后验证 N 小时前」 — a freshness hint with nothing behind it — and all three of
 * 「🔄 上游有新版本」, the compare drawer and 「以 digest 注册」 have nothing to render
 * from (P21-4 §3/§5).
 */
export const ImageManifestSchema = z.object({
  id: z.string(),
  imageId: z.string(),
  imageName: z.string(),
  isBuiltin: z.boolean(),
  /** Full repository coordinate (`ghcr.io/x/y:tag` or `…@sha256:…`) — what a provider pulls. */
  ref: z.string(),
  /** The TAG this row was resolved from. Repeatable: a re-pushed tag makes a 2nd row. */
  version: z.string(),
  baseImage: z.string(),
  /** IMMUTABLE identity of this row (I-IMG-6/7). `sha256:` + 64 hex, never a placeholder. */
  digest: z.string(),
  entrypointContract: EntrypointContractSchema,
  supportedRuntimes: z.array(z.string()),
  resourceDefaults: ResourceDefaultsSchema,
  labelsRequired: z.array(z.string()),
  /**
   * Digest of the platform built-in image this one was found to descend from, decided
   * once at registration (04 §7 ★血统).
   *
   * ⚠️ IT IS A RECORD, NOT A LIVE LINK — the anchor row may be gone, and the value
   * still names the bits this image absorbed. It is deliberately not the anchor's
   * `manifestId`, and deliberately not backed by a foreign key; the reasons live on
   * `image_manifests.derived_from_digest`.
   *
   * ⚠️ `null` MEANS ONE OF TWO THINGS AND `isBuiltin` TELLS THEM APART: a platform
   * root (no ancestor by construction — it IS the anchor) versus a row registered
   * before this column existed (ancestor unrecoverable, and not to be invented). A UI
   * that renders `null` as 「未基于平台镜像」 would libel both.
   */
  derivedFromDigest: z.string().nullable(),
  validationStatus: ImageValidationStatusSchema,
  /**
   * The findings BEHIND `validationStatus` — errors when `invalid`, warnings when
   * `warning`, `null` when clean.
   *
   * ⚠️ ONE ARRAY, NOT TWO, BECAUSE THE TABLE HAS ONE COLUMN (13 §2.4.2
   * `validation_errors`) and the status disambiguates it. A second `warnings` array
   * on the DTO would have nothing to load from — i.e. a field the contract promises
   * and the store cannot fill, which is the `totalBytes` ghost this repo already paid
   * for once. Full three-level detail is returned live by the three endpoints that
   * actually run `validate()` (register / validate / :id/validate).
   */
  validationErrors: z.array(ValidationIssueSchema).nullable(),
  isActive: z.boolean(),
  imageConfig: ImageConfigSchema.nullable(),
  registeredAt: IsoInstantSchema,
  /** ISO instant of the resolution that produced `digest`. */
  resolvedAt: IsoInstantSchema,
});
export type ImageManifestDto = z.infer<typeof ImageManifestSchema>;

/**
 * `POST /api/images` body: the row PLUS the verdict that let it in (27 §6).
 *
 * ⚠️ IT IS A ZOD SCHEMA, NOT A HAND-WRITTEN DTO CLASS. A plain class with `!` fields
 * reflects into OpenAPI as `{"type":"object","properties":{}}` — an EMPTY schema — so
 * codegen hands the frontend `{}` for the one response the wizard reads
 * (`manifest.id`, `validation.status`). The contract would promise a shape it does not
 * describe: the `totalBytes` ghost, one layer up.
 *
 * `created` is deliberately NOT on the wire — 200 vs 201 already says it, and a second
 * channel for the same fact is a second thing that can disagree.
 */
export const RegisterImageResultSchema = z.object({
  manifest: ImageManifestSchema,
  validation: ValidationOutcomeSchema,
});
export type RegisterImageResultDto = z.infer<typeof RegisterImageResultSchema>;

/** `POST /api/images` + `POST /api/images/validate` both take just a reference. */
export const RegisterImageSchema = z.object({
  ref: z.string().min(1).max(512),
});
export type RegisterImageInput = z.infer<typeof RegisterImageSchema>;

/**
 * `PATCH /api/images/:id` — the ONLY entry point for this row's mutable fields.
 *
 * ⚠️ `isActive` ACCEPTS ONLY `false`. Enabling a version necessarily retires the
 * current holder of the same tag (`unique(image_id, version) WHERE is_active`), i.e.
 * it is a two-row 「换」 dressed up as a one-field 「改」 — 副作用大于字面 (10 §6 ★).
 * `true` is refused with a 400 pointing at `POST /api/images/:id/activate`.
 *
 * ⚠️ THESE TWO FIELDS ARE EXACTLY WHAT I-IMG-7 PERMITS (23 §9.2). `digest` /
 * `version` / `baseImage` are never UPDATEd; upgrading is INSERT + pointer swap.
 * Adding a `digest?` here would dismantle that invariant, so the shape IS the
 * invariant's landing site, not a convenience.
 */
export const PatchImageSchema = z.object({
  isActive: z.boolean().optional(),
  imageConfig: ImageConfigInputSchema.optional(),
});
export type PatchImageInput = z.infer<typeof PatchImageSchema>;

/**
 * `POST /api/images/:id/validate` — re-validation (04 §7 时刻②).
 *
 * ⚠️ A DIGEST CHANGE IS A COORDINATE MIGRATION, NOT A 「刷新成功」. When the tag now
 * resolves elsewhere the response must SAY SO (old → new); a silent write-back would
 * hide from the user that their image changed bits.
 */
export const RevalidateOutcomeSchema = ValidationOutcomeSchema.extend({
  /** The digest frozen on this row at registration. Never changes (I-IMG-7). */
  currentDigest: z.string(),
  /** What the tag resolves to NOW. Equal to `currentDigest` unless the tag was re-pushed. */
  upstreamDigest: z.string(),
  digestChanged: z.boolean(),
});
export type RevalidateOutcomeDto = z.infer<typeof RevalidateOutcomeSchema>;

/** `POST /api/images/:id/check-update` — read-only drift probe; never stores anything. */
export const CheckImageUpdateSchema = z.object({
  current: z.object({ digest: z.string(), resolvedAt: IsoInstantSchema }),
  upstream: z.object({ digest: z.string(), validation: ValidationOutcomeSchema }).nullable(),
  changed: z.boolean(),
});
export type CheckImageUpdateDto = z.infer<typeof CheckImageUpdateSchema>;
