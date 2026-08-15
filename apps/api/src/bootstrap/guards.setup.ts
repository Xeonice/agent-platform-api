import { APP_GUARD } from '@nestjs/core';
import type { Provider } from '@nestjs/common';
import { PasscodeGuard } from '../platform/access-passcode/passcode.guard';

/**
 * Global guard wiring (shared/11 §3.1). The active APP_GUARD is the real
 * PasscodeGuard (MVP), replacing NoopAuthGuard: it enforces across REST + MCP-
 * over-HTTP and self-disables when ACCESS_PASSCODE is empty (dev). STDIO MCP is
 * a non-HTTP context and is exempt; GET /api/health is exempt. `PasscodeService`
 * is provided by the @Global AccessPasscodeModule (also serves the terminal WS
 * authenticator), so the guard injects it from there.
 */
export const guardProviders: Provider[] = [{ provide: APP_GUARD, useClass: PasscodeGuard }];
