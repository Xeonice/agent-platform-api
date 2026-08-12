import { resolve } from 'node:path';

/**
 * Minimal env access (a zod-validated config module is a later slice; 01 platform/config).
 * Defaults are SAFE: bind loopback only (shared/11 §3, audit P0-3).
 */
export const env = {
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
  dataRoot: process.env.DATA_ROOT ?? resolve(process.cwd(), 'data'),
  get databaseUrl(): string {
    return process.env.DATABASE_URL ?? resolve(this.dataRoot, 'platform.db');
  },
  accessPasscode: process.env.ACCESS_PASSCODE ?? '',
};

/** True when the bind address is not the loopback interface (triggers a warning). */
export function isExposedBind(host: string): boolean {
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
}
