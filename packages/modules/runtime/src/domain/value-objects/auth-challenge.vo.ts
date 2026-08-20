/**
 * AuthChallenge value object (docs/backend/23 §7.3, 04 §3, testkit RA-05). NOT
 * persisted — lifetime ≤15min in an in-memory session. `expiresAt` (when present)
 * MUST be an ABSOLUTE ISO instant; `instructions` / `challengeRef` are required.
 * The runtime domain re-declares the shape locally (domain → shared-kernel only);
 * it is structurally identical to the contract `AuthChallenge`.
 */
export type RuntimeAuthMethod = 'setup-token' | 'oauth-device' | 'api-key' | 'access-token-paste';

export type AuthChallengeKind = 'url' | 'device-code' | 'paste-prompt';

export interface AuthChallengeProps {
  challengeRef: string;
  method: RuntimeAuthMethod;
  kind: AuthChallengeKind;
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: string;
  instructions: string;
}

export class AuthChallenge {
  readonly challengeRef: string;
  readonly method: RuntimeAuthMethod;
  readonly kind: AuthChallengeKind;
  readonly verificationUrl?: string;
  readonly userCode?: string;
  readonly expiresAt?: string;
  readonly instructions: string;

  private constructor(p: AuthChallengeProps) {
    this.challengeRef = p.challengeRef;
    this.method = p.method;
    this.kind = p.kind;
    this.verificationUrl = p.verificationUrl;
    this.userCode = p.userCode;
    this.expiresAt = p.expiresAt;
    this.instructions = p.instructions;
  }

  static create(p: AuthChallengeProps): AuthChallenge {
    if (!p.challengeRef) throw new Error('AuthChallenge requires challengeRef (RA-05)');
    if (!p.instructions) throw new Error('AuthChallenge requires instructions (RA-05)');
    if (p.expiresAt !== undefined && Number.isNaN(Date.parse(p.expiresAt))) {
      throw new Error('AuthChallenge.expiresAt must be an absolute ISO instant (RA-05)');
    }
    return new AuthChallenge(p);
  }

  toDto(): AuthChallengeProps {
    return {
      challengeRef: this.challengeRef,
      method: this.method,
      kind: this.kind,
      verificationUrl: this.verificationUrl,
      userCode: this.userCode,
      expiresAt: this.expiresAt,
      instructions: this.instructions,
    };
  }
}
