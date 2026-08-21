import type { EncryptedBlob } from '../value-objects/encrypted-blob.vo';
import type { RuntimeAuthMethod } from '../value-objects/obtained-via.vo';

/**
 * Structural twin of contracts' `RuntimeCredential` (domain must not import
 * contracts — boundaries §2.2). The application facade returns this as the
 * contracts `RuntimeCredential`; the shapes are identical so it is assignable.
 *
 * This is a CONTROLLED-PLAINTEXT wrapper (23 §8.2 relaxed I-CRD-2): `content` /
 * `env` values / `accessToken` are plaintext held in memory only. `zeroize()` wipes
 * every buffer/string reference; the caller injects then `zeroize()`s in `finally`.
 */
export interface MaterializedRuntimeCredential {
  runtimeId: string;
  obtainedVia: RuntimeAuthMethod;
  maskedIdentifier?: string;
  issuedAt: string;
  expiresAt?: string;
  credentialFiles: Array<{ containerPath: string; content: string; mode?: string }>;
  env?: Record<string, string>;
  accessToken?: string;
  /** PLATFORM-ONLY full auth file (refresh scanner); never injected (P0-3). */
  authFile?: string;
  zeroize(): void;
}

/**
 * The plaintext PAYLOAD serialized into the encrypted blob for a runtime credential.
 * Only the sensitive parts live here; `runtimeId` / `obtainedVia` / `expiresAt` /
 * `masked` are columns on the Credential row.
 */
export interface RuntimeSecretPayload {
  credentialFiles?: Array<{ containerPath: string; content: string; mode?: string }>;
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
 * `RuntimeSecretPayload` → assemble a `MaterializedRuntimeCredential`. The plaintext
 * Buffer from the cipher is zeroized after parse; the returned wrapper carries only
 * what injection needs. Lives in `domain` so the application facade can drive it
 * without importing infrastructure.
 */
export interface RuntimeCredentialMaterializer {
  materialize(input: MaterializeRuntimeInput): Promise<MaterializedRuntimeCredential>;
}

export const RUNTIME_CREDENTIAL_MATERIALIZER = Symbol('RuntimeCredentialMaterializer');
