import { Global, Module } from '@nestjs/common';
import { ACCESS_GATE_READER, TERMINAL_AUTHENTICATOR } from '@platform/contracts';
import type { AccessGateReader } from '@platform/contracts';
import { PasscodeService } from './passcode.service';
import { PasscodeAttemptLimiter } from './passcode-attempt-limiter';
import { PasscodeTerminalAuthenticator } from './passcode-terminal-authenticator';
import { AccessController } from './access.controller';
import { AccessPasscodeService } from './access-passcode.service';

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
    AccessPasscodeService,
    PasscodeAttemptLimiter,
    { provide: TERMINAL_AUTHENTICATOR, useClass: PasscodeTerminalAuthenticator },
    // 03 §8.5 / 审计 P2-12：webhook 对**私网**地址的放行以「这个部署有门」为前提。
    // automation 那个 package 够不到 `PasscodeService`，所以经 contracts 口递过去。
    {
      provide: ACCESS_GATE_READER,
      useFactory: (passcode: PasscodeService): AccessGateReader => ({
        isEnabled: () => passcode.enabled,
      }),
      inject: [PasscodeService],
    },
  ],
  exports: [
    PasscodeService,
    AccessPasscodeService,
    PasscodeAttemptLimiter,
    TERMINAL_AUTHENTICATOR,
    ACCESS_GATE_READER,
  ],
})
export class AccessPasscodeModule {}
