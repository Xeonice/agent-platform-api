import type { CredentialId } from '@platform/shared-kernel';
import type { Credential } from '../entities/credential.entity';
import type { GitObtainedVia, RuntimeMode } from '../value-objects/obtained-via.vo';

/**
 * CredentialSelectionService (docs/backend/23 §8.5). PURE (A3): candidate sets are
 * pre-fetched by the repository and passed in — no IO here.
 *
 * `forKind` picks the effective git credential by `obtained_via`; `forRuntime` picks
 * the effective runtime credential by `runtimeId` + the effective `mode`
 * (`account`|`api-key`) — NOT by `obtainedVia`, matching the `uq_cred_runtime_active`
 * partial-unique index which keys on `(runtime_id, mode)` (13 §2.5.1 P2-4: the
 * `account` class spans several obtainedVia, so keying on mode is unambiguous).
 */
export const CredentialSelectionService = {
  forKind(kind: GitObtainedVia, candidates: Credential[]): CredentialId | null {
    const active = candidates
      .filter((c) => c.kind === 'git' && c.obtainedVia === kind && !c.isRevoked())
      .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());
    return active.length > 0 ? active[0].id : null;
  },

  forRuntime(
    runtimeId: string,
    activeMode: RuntimeMode,
    candidates: Credential[],
  ): CredentialId | null {
    const active = candidates
      .filter(
        (c) =>
          c.kind === 'runtime' &&
          c.runtimeId === runtimeId &&
          c.mode === activeMode &&
          !c.isRevoked(),
      )
      .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());
    return active.length > 0 ? active[0].id : null;
  },
};
