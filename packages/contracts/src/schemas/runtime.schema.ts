import { z } from 'zod';
import { AbsoluteUrlSchema, IsoInstantSchema } from './primitives';

/**
 * Runtime auth / credential wire contracts (docs/backend/05, 27 §4, shared/10 §7.2/§7.3).
 * ONE zod source produces the REST DTO, the OpenAPI reflection and (where exposed)
 * the MCP inputSchema. Runtime credential READS go through `GET /api/runtimes`
 * (aggregate) — a runtime credential is never reachable via the git collection.
 *
 * SECURITY (23 I-CRD-2): outbound views NEVER carry plaintext — only a masked
 * identifier (`sk-...ab12` / `a***@mail`) and derived status. The inbound `secret`
 * (api-key) and `pastedText` (setup-token) are accepted once over HTTPS, flow
 * through memory only, are encrypted at rest and never round-trip out.
 */

/**
 * 鉴权【方式】 (04 §3 `RuntimeAuthMethod`, = `obtained_via` for runtime rows). This is
 * the per-challenge method, DISTINCT from the effective 【模式】 (`RuntimeAuthMode`).
 */
export const RUNTIME_AUTH_METHODS = [
  'oauth-device',
  'setup-token',
  'api-key',
  'access-token-paste',
] as const;
export const RuntimeAuthMethodSchema = z.enum(RUNTIME_AUTH_METHODS);
export type RuntimeAuthMethod = z.infer<typeof RuntimeAuthMethodSchema>;

/** The interactive begin methods the auth page renders (`getAuthMethods()` subset). */
export const RUNTIME_BEGIN_METHODS = ['oauth-device', 'setup-token'] as const;
export const RuntimeBeginMethodSchema = z.enum(RUNTIME_BEGIN_METHODS);
export type RuntimeBeginMethod = z.infer<typeof RuntimeBeginMethodSchema>;

/**
 * The NON-interactive methods: the user already holds the secret and pastes it, so
 * there is no helper, no pty and no challenge (05 §3.1). Exactly the complement of
 * `RUNTIME_BEGIN_METHODS` within `RUNTIME_AUTH_METHODS`.
 *
 * ⚠️ ONE ENUM, THREE PLACES. `RuntimeAdapter.createCredentialFromSecret`, this wire
 * schema and the application call site must agree; they did not. The contract took
 * `'api-key' | 'access-token-paste'`, the wire took only `z.literal('api-key')`, and
 * the service passed a hard-coded `'api-key'` — so an adapter offering
 * `access-token-paste` had its declaration accepted, stripped from `authMethods`, and
 * then refused at the door. Deriving all three from one constant removes the seam.
 */
export const RUNTIME_SECRET_METHODS = ['api-key', 'access-token-paste'] as const;
export const RuntimeSecretMethodSchema = z.enum(RUNTIME_SECRET_METHODS);
export type RuntimeSecretMethod = z.infer<typeof RuntimeSecretMethodSchema>;

/** 生效【模式】 (05 §4 `active_auth_method`): the two-way global switch. */
export const RUNTIME_AUTH_MODES = ['account', 'api-key'] as const;
export const RuntimeAuthModeSchema = z.enum(RUNTIME_AUTH_MODES);
export type RuntimeAuthMode = z.infer<typeof RuntimeAuthModeSchema>;

/** Per-runtime aggregate credential status (27 §4, UI badge). */
export const CREDENTIAL_STATUSES = ['none', 'active', 'expiring', 'expired'] as const;
export const CredentialStatusSchema = z.enum(CREDENTIAL_STATUSES);
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>;

/** device-code poll result (05 §3). */
export const AUTH_STATUSES = ['pending', 'success', 'expired', 'error'] as const;
export const AuthStatusSchema = z.enum(AUTH_STATUSES);
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

/** Challenge render kind (shared/10 §7.2). */
export const AUTH_CHALLENGE_KINDS = ['url', 'device-code', 'paste-prompt'] as const;
export const AuthChallengeKindSchema = z.enum(AUTH_CHALLENGE_KINDS);
export type AuthChallengeKind = z.infer<typeof AuthChallengeKindSchema>;

/**
 * AuthChallenge (04 §3, 23 §7.3, shared/10). NOT persisted — lifetime ≤15min in an
 * in-memory session (`challengeRef → helper pty ref`). `expiresAt` is an absolute
 * ISO instant (testkit RA-05); `instructions` / `challengeRef` are required.
 */
export const AuthChallengeSchema = z.object({
  challengeRef: z.string(),
  method: RuntimeAuthMethodSchema,
  kind: AuthChallengeKindSchema,
  verificationUrl: AbsoluteUrlSchema.optional(),
  userCode: z.string().optional(),
  expiresAt: IsoInstantSchema.optional(),
  instructions: z.string(),
});
export type AuthChallengeDto = z.infer<typeof AuthChallengeSchema>;

/**
 * Per-mode credential summary (P21-3 §3): the runtime card lists BOTH "🎫 帐号授权"
 * and "🔑 API Key" as parallel rows, each with its own masked identifier / expiry /
 * last-used / [吊销] button — so each row carries its own `credentialId` (the
 * `DELETE .../credentials/:credentialId` target). Only CONFIGURED modes appear;
 * an unconfigured mode is absent (frontend renders "○ 未配置 + [配置]"). Masked only,
 * never plaintext (S3 discipline / I-CRD-2).
 */
export const RUNTIME_CREDENTIAL_SUMMARY_STATUSES = ['ok', 'expiring', 'expired'] as const;
export const RuntimeCredentialSummaryStatusSchema = z.enum(RUNTIME_CREDENTIAL_SUMMARY_STATUSES);
export type RuntimeCredentialSummaryStatus = z.infer<typeof RuntimeCredentialSummaryStatusSchema>;

export const RuntimeCredentialSummarySchema = z.object({
  credentialId: z.string(),
  mode: RuntimeAuthModeSchema,
  maskedIdentifier: z.string(),
  status: RuntimeCredentialSummaryStatusSchema,
  expiresAt: IsoInstantSchema.optional(),
  lastUsedAt: IsoInstantSchema.optional(),
});
export type RuntimeCredentialSummary = z.infer<typeof RuntimeCredentialSummarySchema>;

/** Aggregate runtime row (`GET /api/runtimes`, 27 §4). */
export const RuntimeDtoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  vendor: z.string(),
  /**
   * What `getAuthMethods()` declared — the WHOLE closed set (RA-09), not a
   * hand-maintained subset.
   *
   * ⚠️ IT USED TO BE `RuntimeBeginMethodSchema.or(z.literal('api-key'))`, i.e.
   * structurally unable to carry `access-token-paste`, and the application layer
   * filtered that value out to fit. An adapter whose only method was
   * `access-token-paste` therefore reached the UI as `authMethods: []` — rendered as
   * 「没有可用的配置方式」 for a runtime that is perfectly configurable.
   */
  authMethods: z.array(RuntimeAuthMethodSchema),
  /**
   * Advisory prefix for this runtime's api-key (`sk-` / `sk-ant-`), declared by the
   * adapter. Absent ⇒ the runtime states no prefix; the UI must then not judge format.
   */
  apiKeyPrefix: z.string().optional(),
  /** Aggregate status of the ACTIVE credential (badge). Per-mode detail is `credentials`. */
  credentialStatus: CredentialStatusSchema,
  maskedIdentifier: z.string().optional(),
  expiresAt: IsoInstantSchema.optional(),
  /** Which mode is [生效中]; `null`/absent when nothing is configured. */
  activeAuthMethod: RuntimeAuthModeSchema.optional(),
  /** One entry per CONFIGURED mode (P21-3 §3 parallel cards); each carries its id. */
  credentials: z.array(RuntimeCredentialSummarySchema),
});
export type RuntimeDto = z.infer<typeof RuntimeDtoSchema>;

/** Single-runtime status (`GET /api/runtimes/:rt/credentials/status`, 27 §4). */
export const RuntimeCredentialStatusSchema = RuntimeDtoSchema;
export type RuntimeCredentialStatusDto = RuntimeDto;

/** `PUT /api/runtimes/:rt/auth-mode` — body field is `method` (P1-1), value = mode. */
export const SetAuthModeRequestSchema = z.object({ method: RuntimeAuthModeSchema });
export type SetAuthModeRequest = z.infer<typeof SetAuthModeRequestSchema>;

/** `POST /api/runtimes/:rt/auth/begin` (interactive begin methods only). */
export const BeginAuthRequestSchema = z.object({ method: RuntimeBeginMethodSchema });
export type BeginAuthRequest = z.infer<typeof BeginAuthRequestSchema>;

/** `POST /api/runtimes/:rt/auth/complete` — setup-token paste. */
export const CompleteAuthRequestSchema = z.object({
  challengeRef: z.string().min(1),
  pastedText: z.string().min(1).max(4096).optional(),
  cancel: z.boolean().optional(),
});
export type CompleteAuthRequest = z.infer<typeof CompleteAuthRequestSchema>;

/**
 * `POST /api/runtimes/:rt/credentials/secret` — api-key short-circuit (05 §3.1).
 * `secret` is on the log-redaction whitelist (P2-3): the ValidationPipe never
 * echoes its value, only the field path + rule.
 */
export const SubmitSecretRequestSchema = z.object({
  method: RuntimeSecretMethodSchema,
  secret: z.string().min(1).max(8192),
});
export type SubmitSecretRequest = z.infer<typeof SubmitSecretRequestSchema>;

/** Masked identifier only — the secret NEVER round-trips out. */
export const MaskedCredentialResultSchema = z.object({ maskedIdentifier: z.string() });
export type MaskedCredentialResult = z.infer<typeof MaskedCredentialResultSchema>;

/** `GET /api/runtimes/:rt/auth/status` poll result. */
export const AuthStatusResultSchema = z.object({
  status: AuthStatusSchema,
  maskedIdentifier: z.string().optional(),
});
export type AuthStatusResult = z.infer<typeof AuthStatusResultSchema>;

/** `PUT /api/runtimes/:rt/auth-mode` result (23 §7.1 aggregate projection). */
export const RuntimeSettingsDtoSchema = z.object({
  runtimeId: z.string(),
  activeAuthMethod: RuntimeAuthModeSchema,
});
export type RuntimeSettingsDto = z.infer<typeof RuntimeSettingsDtoSchema>;
