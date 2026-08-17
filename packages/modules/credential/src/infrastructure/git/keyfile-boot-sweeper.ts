import { rm } from 'node:fs/promises';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { gitKeysBaseDir } from './keyfile-dir';

/**
 * Boot sweep of the platform-private keyfile base dir (docs/backend/03 §7.3 F).
 * `dispose()` handles the normal path, but `try/finally` and exit hooks do NOT run
 * under SIGKILL/OOM/power-loss — so on startup we wipe the whole base dir. This is
 * the crash fallback, not the only defence. Sweeping a non-existent dir is a no-op,
 * so this is safe even on a fresh install / during openapi emit.
 */
@Injectable()
export class KeyfileBootSweeper implements OnApplicationBootstrap {
  private readonly logger = new Logger('KeyfileBootSweeper');

  async onApplicationBootstrap(): Promise<void> {
    const base = gitKeysBaseDir();
    try {
      await rm(base, { recursive: true, force: true });
    } catch (e) {
      this.logger.warn(`keyfile boot sweep skipped: ${(e as Error).message}`);
    }
  }
}
