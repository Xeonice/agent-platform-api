import { AggregateRoot } from '@platform/shared-kernel';
import type { CredentialId } from '@platform/shared-kernel';
import { EncryptedBlob, Erased, isEncrypted } from '../value-objects/encrypted-blob.vo';
import type { CredentialSecret } from '../value-objects/encrypted-blob.vo';
import { MaskedIdentifier } from '../value-objects/masked-identifier.vo';
import type { CredentialMetadata } from '../value-objects/credential-metadata.vo';
import { isRuntimeAuthMethod, modeForRuntimeMethod } from '../value-objects/obtained-via.vo';
import type {
  GitObtainedVia,
  ObtainedVia,
  RuntimeAuthMethod,
  RuntimeMode,
} from '../value-objects/obtained-via.vo';
import { InvalidCredentialError, CredentialRevokedError } from '../errors/credential-errors';
import { CredentialStored, CredentialRevoked } from '../events/credential-events';

export type CredentialKind = 'runtime' | 'git';

export interface CredentialProps {
  id: CredentialId;
  kind: CredentialKind;
  runtimeId: string | null;
  obtainedVia: ObtainedVia;
  masked: MaskedIdentifier;
  mode: RuntimeMode | null; // git ⇒ NULL (I-CRD-1); runtime ⇒ account|api-key
  allowedHosts: string[];
  metadata: CredentialMetadata | null;
  secret: CredentialSecret;
  ownerRef: string | null;
  issuedAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  refreshFailures: number;
  lastRefreshedAt: Date | null;
}

/**
 * Credential aggregate root (docs/backend/23 §8.1). Serves BOTH the `git`
 * (S3) and `runtime` (S4) halves. Invariants enforced here:
 *   - I-CRD-1: kind ↔ runtimeId / mode / obtainedVia cross-constraints
 *   - I-CRD-8: git-https-token ⇒ allowedHosts non-empty (≥1 host)
 *   - I-CRD-3: revoke() wipes the ciphertext to `Erased`, metadata retained
 *   - I-CRD-4: a revoked credential cannot be selected / materialized
 */
export class Credential extends AggregateRoot<CredentialId> {
  readonly kind: CredentialKind;
  readonly runtimeId: string | null;
  readonly obtainedVia: ObtainedVia;
  private _masked: MaskedIdentifier;
  readonly mode: RuntimeMode | null;
  readonly allowedHosts: string[];
  private _metadata: CredentialMetadata | null;
  private _secret: CredentialSecret;
  readonly ownerRef: string | null;
  readonly issuedAt: Date;
  readonly expiresAt: Date | null;
  private _lastUsedAt: Date | null;
  private _revokedAt: Date | null;
  readonly refreshFailures: number;
  readonly lastRefreshedAt: Date | null;

  private constructor(props: CredentialProps) {
    super(props.id);
    this.kind = props.kind;
    this.runtimeId = props.runtimeId;
    this.obtainedVia = props.obtainedVia;
    this._masked = props.masked;
    this.mode = props.mode;
    this.allowedHosts = props.allowedHosts;
    this._metadata = props.metadata;
    this._secret = props.secret;
    this.ownerRef = props.ownerRef;
    this.issuedAt = props.issuedAt;
    this.expiresAt = props.expiresAt;
    this._lastUsedAt = props.lastUsedAt;
    this._revokedAt = props.revokedAt;
    this.refreshFailures = props.refreshFailures;
    this.lastRefreshedAt = props.lastRefreshedAt;
  }

  static rehydrate(props: CredentialProps): Credential {
    return new Credential(props);
  }

  /** Create a git credential (SSH key or HTTPS token). Enforces I-CRD-1/8. */
  static createGit(input: {
    id: CredentialId;
    obtainedVia: GitObtainedVia;
    masked: MaskedIdentifier;
    allowedHosts: string[];
    metadata?: CredentialMetadata | null;
    secret: EncryptedBlob;
    now: Date;
    expiresAt?: Date | null;
  }): Credential {
    if (input.obtainedVia === 'git-https-token' && input.allowedHosts.length === 0) {
      throw new InvalidCredentialError(
        'git-https-token requires a non-empty allowedHosts whitelist (I-CRD-8)',
      );
    }
    const cred = new Credential({
      id: input.id,
      kind: 'git',
      runtimeId: null,
      obtainedVia: input.obtainedVia,
      masked: input.masked,
      mode: null,
      allowedHosts: input.allowedHosts,
      metadata: input.metadata ?? null,
      secret: input.secret,
      ownerRef: null,
      issuedAt: input.now,
      expiresAt: input.expiresAt ?? null,
      lastUsedAt: null,
      revokedAt: null,
      refreshFailures: 0,
      lastRefreshedAt: null,
    });
    cred.raise(new CredentialStored(input.id, null, input.obtainedVia, input.now));
    return cred;
  }

  /**
   * Create a runtime credential (S4). Enforces I-CRD-1: `runtimeId` non-empty,
   * `obtainedVia ∈ RuntimeAuthMethod`; `mode` is DERIVED from `obtainedVia`
   * (`api-key`→`api-key`, else `account`) so it is never a caller-supplied mismatch.
   */
  static createRuntime(input: {
    id: CredentialId;
    runtimeId: string;
    obtainedVia: RuntimeAuthMethod;
    masked: MaskedIdentifier;
    metadata?: CredentialMetadata | null;
    secret: EncryptedBlob;
    now: Date;
    expiresAt?: Date | null;
  }): Credential {
    if (!input.runtimeId || input.runtimeId.trim().length === 0) {
      throw new InvalidCredentialError(
        'runtime credential requires a non-empty runtimeId (I-CRD-1)',
      );
    }
    if (!isRuntimeAuthMethod(input.obtainedVia)) {
      throw new InvalidCredentialError(
        `runtime credential obtainedVia must be a RuntimeAuthMethod (I-CRD-1), got '${input.obtainedVia}'`,
      );
    }
    const cred = new Credential({
      id: input.id,
      kind: 'runtime',
      runtimeId: input.runtimeId,
      obtainedVia: input.obtainedVia,
      masked: input.masked,
      mode: modeForRuntimeMethod(input.obtainedVia),
      allowedHosts: [],
      metadata: input.metadata ?? null,
      secret: input.secret,
      ownerRef: null,
      issuedAt: input.now,
      expiresAt: input.expiresAt ?? null,
      lastUsedAt: null,
      revokedAt: null,
      refreshFailures: 0,
      lastRefreshedAt: null,
    });
    cred.raise(new CredentialStored(input.id, input.runtimeId, input.obtainedVia, input.now));
    return cred;
  }

  get masked(): MaskedIdentifier {
    return this._masked;
  }
  get metadata(): CredentialMetadata | null {
    return this._metadata;
  }
  get secret(): CredentialSecret {
    return this._secret;
  }
  get lastUsedAt(): Date | null {
    return this._lastUsedAt;
  }
  get revokedAt(): Date | null {
    return this._revokedAt;
  }

  isRevoked(): boolean {
    return this._revokedAt !== null;
  }

  /** I-CRD-4: guard before a credential is used (materialize / selection). */
  assertUsable(): EncryptedBlob {
    if (this.isRevoked() || !isEncrypted(this._secret)) {
      throw new CredentialRevokedError();
    }
    return this._secret;
  }

  /** I-CRD-3: revoke → wipe ciphertext to `Erased`, keep metadata for audit. */
  revoke(now: Date): void {
    if (this.isRevoked()) return;
    this._revokedAt = now;
    this._secret = new Erased(now);
    this.raise(new CredentialRevoked(this.id, this.runtimeId, this.obtainedVia, now));
  }

  touchLastUsed(now: Date): void {
    this._lastUsedAt = now;
  }
}
