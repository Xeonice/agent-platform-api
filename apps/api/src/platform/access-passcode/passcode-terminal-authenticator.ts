import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '@platform/shared-kernel';
import type { Clock } from '@platform/shared-kernel';
import type { TerminalAuthenticator, TerminalHandshakeCredentials } from '@platform/contracts';
import { PasscodeService } from './passcode.service';

/**
 * Composition-root adapter binding the `terminal` module's `TerminalAuthenticator`
 * port to the access-passcode MVP (shared/11 §3.1). Closes S1 audit P1-1: the
 * REST/MCP `PasscodeGuard` self-exempts non-HTTP contexts, so the /terminal WS
 * handshake was unauthenticated — this re-applies the SAME passcode/session check
 * on the socket handshake. When no passcode is configured it allows (dev parity).
 *
 * Lives in the access-passcode folder (eslint time/random port-impl exemption),
 * though it reads time via the injected Clock port anyway.
 */
@Injectable()
export class PasscodeTerminalAuthenticator implements TerminalAuthenticator {
  constructor(
    private readonly passcodes: PasscodeService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  authorize(credentials: TerminalHandshakeCredentials): boolean {
    if (!this.passcodes.enabled) return true; // passcode disabled ⇒ open (dev)
    const now = this.clock.now().getTime();
    if (
      credentials.sessionToken &&
      this.passcodes.verifySessionToken(credentials.sessionToken, now)
    ) {
      return true;
    }
    if (credentials.passcode !== undefined && this.passcodes.matches(credentials.passcode)) {
      return true;
    }
    return false;
  }
}
