import type { EncryptedBlob } from '../value-objects/encrypted-blob.vo';
import type { RuntimeAuthMethod } from '../value-objects/obtained-via.vo';

/** One credential file to materialize inside a sandbox — `~/`-relative path (D-19). */
export interface RuntimeCredentialFileMaterial {
  containerPath: string;
  content: string;
  mode?: string;
}

/**
 * Structural twin of contracts' `InjectableRuntimeCredential` (domain must not import
 * contracts — boundaries §2.2). The application facade returns this AS the contracts
 * type; the shapes are identical so it is assignable.
 *
 * This is a CONTROLLED-PLAINTEXT wrapper (23 §8.2 relaxed I-CRD-2): `content` / `env`
 * values / `accessToken` are plaintext held in memory only. `zeroize()` drops every
 * reference; the caller injects then `zeroize()`s in `finally`.
 *
 * ★ 裁决 D-18 (05 §4.3): there is deliberately NO `authFile` here. The injection path
 * — everything downstream of `prepareActive` — therefore cannot reach a real
 * `refresh_token` even by accident (I-CRD-9). The refresh path uses the separate
 * `MaterializedRefreshCredential` below.
 */
export interface MaterializedRuntimeCredential {
  runtimeId: string;
  obtainedVia: RuntimeAuthMethod;
  maskedIdentifier?: string;
  issuedAt: string;
  expiresAt?: string;
  credentialFiles: RuntimeCredentialFileMaterial[];
  env?: Record<string, string>;
  accessToken?: string;
  zeroize(): void;
}

/**
 * PLATFORM-ONLY twin of contracts' `RefreshableRuntimeCredential`: injectable material
 * PLUS the COMPLETE provider auth file (with the real `refresh_token`). Produced only
 * by `materializeForRefresh` and consumed only by the refresh scanner (05 §5.1).
 */
export type MaterializedRefreshCredential = MaterializedRuntimeCredential & {
  authFile: string;
};

/**
 * The plaintext PAYLOAD serialized into the encrypted blob for a runtime credential.
 * Only the sensitive parts live here; `runtimeId` / `obtainedVia` / `expiresAt` /
 * `masked` are columns on the Credential row.
 *
 * ★ `credentialFiles` and `authFile` are SEPARATE fields on purpose and are written by
 * the adapter at credential BIRTH (05 §4.3 ②): `credentialFiles` already holds the
 * SANITIZED provider auth file (refresh_token = the shared-kernel placeholder), while
 * `authFile` holds the complete one. Nothing downstream ever converts between them.
 */
export interface RuntimeSecretPayload {
  credentialFiles?: RuntimeCredentialFileMaterial[];
  env?: Record<string, string>;
  accessToken?: string;
  /** PLATFORM-ONLY full auth file (refresh scanner); never injected (P0-3). */
  authFile?: string;
}

export interface MaterializeRuntimeInput {
  runtimeId: string;
  obtainedVia: RuntimeAuthMethod;
  maskedIdentifier?: string;
  issuedAt: Date;
  expiresAt?: Date | null;
  secret: EncryptedBlob;
}

/**
 * RuntimeCredentialMaterializer PORT (05 §4). Decrypt the blob → parse the
 * `RuntimeSecretPayload` → assemble a controlled-plaintext wrapper. The plaintext
 * Buffer from the cipher is zeroized after parse. Lives in `domain` so the application
 * facade can drive it without importing infrastructure.
 *
 * TWO methods, not one with a flag (裁决 D-18): the injection assembler never reads
 * `payload.authFile` at all, so no branch, fallback or future edit inside the
 * injection path can surface it. The refresh assembler is the single place that does.
 */
export interface RuntimeCredentialMaterializer {
  /** Injection path — assembles WITHOUT ever touching `payload.authFile`. */
  materializeForInjection(input: MaterializeRuntimeInput): Promise<MaterializedRuntimeCredential>;
  /**
   * Refresh path (05 §5.1) — the only assembler that reads the full auth file.
   * Throws `MissingPlatformAuthFileError` when the credential carries none, so the
   * caller never has to defend against an `authFile` that is typed as present.
   */
  materializeForRefresh(input: MaterializeRuntimeInput): Promise<MaterializedRefreshCredential>;
}

/**
 * The credential has no platform-only auth file, so it cannot be refreshed by seeding
 * a helper HOME (05 §5.1). Distinct from a decryption failure — this one means the
 * credential is simply of a kind that carries no refreshable material (api-key, a
 * paste-only token, a runtime whose CLI keeps no auth file).
 */
export class MissingPlatformAuthFileError extends Error {
  constructor(credentialDescription: string) {
    super(`${credentialDescription} carries no platform auth file to refresh`);
    this.name = 'MissingPlatformAuthFileError';
  }
}

export const RUNTIME_CREDENTIAL_MATERIALIZER = Symbol('RuntimeCredentialMaterializer');
