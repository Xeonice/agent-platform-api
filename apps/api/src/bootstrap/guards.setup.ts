import { APP_GUARD } from '@nestjs/core';
import type { Provider } from '@nestjs/common';
import { NoopAuthGuard } from '../platform/access-passcode/noop-auth.guard';

/**
 * Global guard wiring (shared/11 §3). Active guard is NoopAuthGuard (allow-all);
 * PasscodeGuard is the MVP replacement (11 §3.1) — swap the useClass here to
 * enable it across REST / MCP / WS at once.
 */
export const guardProviders: Provider[] = [{ provide: APP_GUARD, useClass: NoopAuthGuard }];
