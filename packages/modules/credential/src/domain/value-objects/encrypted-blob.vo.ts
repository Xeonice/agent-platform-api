/**
 * EncryptedBlob / Erased (docs/backend/23 §8.3). The ciphertext at rest:
 * `{ blob, iv, authTag, keyId }` (all base64); `keyId` supports key rotation.
 * `Erased` is its sibling — an explicit TYPE (not a null value) that expresses
 * "revoked, ciphertext physically wiped" so a consumer cannot forget the null
 * check (I-CRD-3).
 */
export class EncryptedBlob {
  readonly kind = 'encrypted' as const;
  constructor(
    readonly blob: string,
    readonly iv: string,
    readonly authTag: string,
    readonly keyId: string,
  ) {}
}

export class Erased {
  readonly kind = 'erased' as const;
  constructor(readonly erasedAt: Date) {}
}

export type CredentialSecret = EncryptedBlob | Erased;

export function isEncrypted(s: CredentialSecret): s is EncryptedBlob {
  return s.kind === 'encrypted';
}
