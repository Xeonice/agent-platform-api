import { AggregateRoot } from '@platform/shared-kernel';
import type { CredentialId } from '@platform/shared-kernel';
import { EncryptedBlob, Erased, isEncrypted } from '../value-objects/encrypted-blob.vo';
import type { CredentialSecret } from '../value-objects/encrypted-blob.vo';
import { MaskedIdentifier } from '../value-objects/masked-identifier.vo';
import type { CredentialMetadata } from '../value-objects/credential-metadata.vo';
import type { GitObtainedVia } from '../value-objects/obtained-via.vo';
import { InvalidCredentialError, CredentialRevokedError } from '../errors/credential-errors';
import { CredentialStored, CredentialRevoked } from '../events/credential-events';

export type CredentialKind = 'runtime' | 'git';

export interface CredentialProps {
  id: CredentialId;
  kind: CredentialKind;
  runtimeId: string | null;
  obtainedVia: GitObtainedVia;
  masked: MaskedIdentifier;
  mode: null; // git ⇒ always NULL (I-CRD-1)
  allowedHosts: string[];
  metadata: CredentialMetadata | null;
  secret: CredentialSecret;
  ownerRef: string | null;
  issuedAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Credential aggregate root (docs/backend/23 §8.1). This slice builds ONLY
 * `kind='git'` credentials (SSH key / HTTPS token). Invariants enforced here:
 *   - I-CRD-1: git ⇒ runtimeId null, mode null, obtainedVia ∈ {git-ssh-key, git-https-token}
 *   - I-CRD-8: git-https-token ⇒ allowedHosts non-empty (≥1 host)
 *   - I-CRD-3: revoke() wipes the ciphertext to `Erased`, metadata retained
 *   - I-CRD-4: a revoked credential cannot be selected / materialized
 */
export class Credential extends AggregateRoot<CredentialId> {
  readonly kind: CredentialKind;
  readonly runtimeId: string | null;
  readonly obtainedVia: GitObtainedVia;
  private _masked: MaskedIdentifier;
  readonly mode: null;
  readonly allowedHosts: string[];
  private _metadata: CredentialMetadata | null;
  private _secret: CredentialSecret;
  readonly ownerRef: string | null;
  readonly issuedAt: Date;
  readonly expiresAt: Date | null;
  private _lastUsedAt: Date | null;
  private _revokedAt: Date | null;

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
    });
    cred.raise(new CredentialStored(input.id, input.now));
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
    this.raise(new CredentialRevoked(this.id, now));
  }

  touchLastUsed(now: Date): void {
    this._lastUsedAt = now;
  }
}
