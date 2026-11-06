/** Public application boundary for revocation cleanup. The consumer holds IDs,
 * never a credential aggregate, injection-ledger entity or repository capability. */
export interface CredentialRevocationBindingRef {
  readonly bindingId: string;
  readonly credentialId: string;
  readonly sandboxId: string;
}

export const CREDENTIAL_REVOCATION_FACADE = Symbol('CredentialRevocationFacade');

export interface CredentialRevocationFacade {
  listPendingRevocations(): Promise<readonly CredentialRevocationBindingRef[]>;
  listForRevokedCredential(
    credentialId: string,
  ): Promise<readonly CredentialRevocationBindingRef[]>;
  /** Called only after the sandbox context confirms the original resource was
   * removed. This context owns the transaction and timestamp. False means the
   * exact pending revoked binding no longer matches; no other row is changed. */
  confirmCleared(binding: CredentialRevocationBindingRef): Promise<boolean>;
}
