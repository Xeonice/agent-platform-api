import { Injectable, type CanActivate } from '@nestjs/common';

/**
 * NoopAuthGuard — the reserved auth slot (shared/11 §3). Allows everything.
 * REST / MCP / WS all go through this same Guard abstraction, so wiring a real
 * user system later means swapping the implementation, not touching business code.
 * The first real implementation is PasscodeGuard (11 §3.1, MVP).
 */
@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
