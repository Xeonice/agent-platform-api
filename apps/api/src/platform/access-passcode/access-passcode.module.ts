import { Global, Module } from '@nestjs/common';
import { TERMINAL_AUTHENTICATOR } from '@platform/contracts';
import { PasscodeService } from './passcode.service';
import { PasscodeAttemptLimiter } from './passcode-attempt-limiter';
import { PasscodeTerminalAuthenticator } from './passcode-terminal-authenticator';
import { AccessController } from './access.controller';

/**
 * @Global access-passcode assembly (shared/11 §3.1). Provides + exports the
 * `PasscodeService` (consumed by the REST/MCP `PasscodeGuard`), the shared
 * `PasscodeAttemptLimiter` (guard + unlock endpoint share one lockout), and the
 * `TERMINAL_AUTHENTICATOR` port (consumed by the cross-module `TerminalGateway`).
 * Being @Global lets the gateway — which lives in the separate `@platform/terminal`
 * package and must not import app internals — receive the authenticator by token.
 * Hosts the `POST /api/access/unlock` controller.
 */
@Global()
@Module({
  controllers: [AccessController],
  providers: [
    PasscodeService,
    PasscodeAttemptLimiter,
    { provide: TERMINAL_AUTHENTICATOR, useClass: PasscodeTerminalAuthenticator },
  ],
  exports: [PasscodeService, PasscodeAttemptLimiter, TERMINAL_AUTHENTICATOR],
})
export class AccessPasscodeModule {}
