import { z } from 'zod';

/**
 * Git credential zod single source (docs/backend/02 §5.1, 13 §2.5.1, 27 §5,
 * shared/10). One place produces the REST DTO, the OpenAPI reflection and the
 * MCP inputSchema (Git credentials are REST-only — they are NOT registered to
 * MCP, 02 §5.2 / 05 §3.2).
 *
 * SECURITY (23 I-CRD-2): the OUTBOUND masked view NEVER carries the private key
 * or the token — SSH is a `SHA256:` fingerprint, an HTTPS token is a tail. The
 * inbound `secret` is accepted once over HTTPS, flows through memory only, and
 * is encrypted at rest — it never round-trips out.
 */

/** Wire-level credential type (27 §5). Maps to `obtained_via` git-ssh-key/git-https-token. */
export const GitCredentialTypeSchema = z.enum(['ssh-key', 'https-token']);
export type GitCredentialType = z.infer<typeof GitCredentialTypeSchema>;

/** Non-sensitive provider hint used for known_hosts pinning + display (13 §2.5.1). */
export const GitPlatformSchema = z.enum(['github', 'gitlab', 'gitee', 'other']);
export type GitPlatform = z.infer<typeof GitPlatformSchema>;

/**
 * Recorded host public key (03 §7.3 H). A host public key is NOT a secret and is
 * stored/returned in the clear (same nature as allowedHosts).
 */
export const KnownHostSchema = z.object({
  host: z.string(),
  keyType: z.string(),
  fingerprint: z.string(),
  firstSeenAt: z.string(),
});
export type KnownHost = z.infer<typeof KnownHostSchema>;

/**
 * Masked read model (GET /api/credentials?kind=git, 27 §5). `maskedIdentifier` is
 * a `SHA256:` fingerprint for SSH / a tail for a token; `allowedHosts` is the
 * non-sensitive host whitelist; the private key / token are NEVER present.
 */
export const MaskedGitCredentialSchema = z.object({
  id: z.string(),
  kind: z.literal('git'),
  type: GitCredentialTypeSchema,
  maskedIdentifier: z.string(),
  platform: GitPlatformSchema.optional(),
  allowedHosts: z.array(z.string()),
  knownHosts: z.array(KnownHostSchema).optional(),
  lastUsedAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type MaskedGitCredential = z.infer<typeof MaskedGitCredentialSchema>;

/**
 * Store request (POST /api/credentials/git, 27 §5). `https-token` MUST carry a
 * non-empty `allowedHosts` whitelist (C / I-CRD-8); `ssh-key` may carry hosts for
 * known_hosts pinning + display. Cross-field rules (host whitelist required for
 * tokens, passphrase-protected key rejected) are enforced in the application +
 * domain (NOT as a zod `.refine`, which produces a ZodEffects Swagger cannot
 * introspect — same discipline as CreateProjectSchema).
 */
export const CreateGitCredentialSchema = z.object({
  type: GitCredentialTypeSchema,
  secret: z.string().min(1),
  platform: GitPlatformSchema.optional(),
  allowedHosts: z.array(z.string()).default([]),
});
export type CreateGitCredentialInput = z.infer<typeof CreateGitCredentialSchema>;

/** Store response — masked identifier only (never the secret). */
export const StoreGitCredentialResultSchema = z.object({
  id: z.string(),
  maskedIdentifier: z.string(),
});
export type StoreGitCredentialResult = z.infer<typeof StoreGitCredentialResultSchema>;

/**
 * Test-connection request (POST /api/credentials/git/test, 03 §7.4). A discriminated
 * union over `source` (coordinator ruling): the product UX needs BOTH "test before
 * save" (an INLINE not-yet-stored pasted secret, materialized transiently and NEVER
 * written to the vault) and "test an existing card" (a STORED credential decrypted
 * from the vault). Still ONE route — no new endpoint.
 */
export const InlineGitTestSchema = z.object({
  source: z.literal('inline'),
  type: GitCredentialTypeSchema,
  secret: z.string().min(1),
  platform: GitPlatformSchema.optional(),
  allowedHosts: z.array(z.string()).default([]),
  repoUrl: z.string().min(1).max(2048).optional(),
});
export type InlineGitTestInput = z.infer<typeof InlineGitTestSchema>;

export const StoredGitTestSchema = z.object({
  source: z.literal('stored'),
  credentialId: z.string(),
  repoUrl: z.string().min(1).max(2048).optional(),
});
export type StoredGitTestInput = z.infer<typeof StoredGitTestSchema>;

export const GitTestRequestSchema = z.discriminatedUnion('source', [
  InlineGitTestSchema,
  StoredGitTestSchema,
]);
export type GitTestRequestInput = z.infer<typeof GitTestRequestSchema>;

/**
 * Test-connection result (03 §7.4). NEVER carries a ref list (would leak private
 * branch names). `errorCode` reuses the clone taxonomy subset relevant to a probe.
 */
export const GitTestErrorCodeSchema = z.enum([
  'CLONE_FAILED_PERMISSION',
  'CLONE_FAILED_NETWORK',
  'TIMEOUT',
]);
export type GitTestErrorCode = z.infer<typeof GitTestErrorCodeSchema>;

export const GitTestResultSchema = z.object({
  ok: z.boolean(),
  errorCode: GitTestErrorCodeSchema.optional(),
  message: z.string().optional(),
});
export type GitTestResult = z.infer<typeof GitTestResultSchema>;
