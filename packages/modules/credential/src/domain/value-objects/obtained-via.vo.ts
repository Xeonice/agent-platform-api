/**
 * Git credential enums (docs/backend/23 §8.1, 13 §2.5.1). This slice is git-only;
 * `obtained_via` is the superset column but only its two git values are produced
 * here. `mode` is always NULL for git (I-CRD-1).
 */
export type GitObtainedVia = 'git-ssh-key' | 'git-https-token';

export type GitPlatform = 'github' | 'gitlab' | 'gitee' | 'other';

/** Wire `type` (27 §5) ↔ domain `obtained_via`. */
export function obtainedViaFromType(type: 'ssh-key' | 'https-token'): GitObtainedVia {
  return type === 'ssh-key' ? 'git-ssh-key' : 'git-https-token';
}

export function typeFromObtainedVia(via: GitObtainedVia): 'ssh-key' | 'https-token' {
  return via === 'git-ssh-key' ? 'ssh-key' : 'https-token';
}
