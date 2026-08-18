/**
 * Git credential enums (docs/backend/23 §8.1, 13 §2.5.1). This slice is git-only;
 * `obtained_via` is the superset column but only its two git values are produced
 * here. `mode` is always NULL for git (I-CRD-1).
 */
export type GitObtainedVia = 'git-ssh-key' | 'git-https-token';

// Single source of truth lives in the shared kernel's git-platform registry; re-export
// so domain code keeps its familiar `./obtained-via.vo` import site without a duplicate
// literal union (the domain boundary allows `domain → shared-kernel`, not `→ contracts`).
export type { GitPlatform } from '@platform/shared-kernel';

/** Wire `type` (27 §5) ↔ domain `obtained_via`. */
export function obtainedViaFromType(type: 'ssh-key' | 'https-token'): GitObtainedVia {
  return type === 'ssh-key' ? 'git-ssh-key' : 'git-https-token';
}

export function typeFromObtainedVia(via: GitObtainedVia): 'ssh-key' | 'https-token' {
  return via === 'git-ssh-key' ? 'ssh-key' : 'https-token';
}
