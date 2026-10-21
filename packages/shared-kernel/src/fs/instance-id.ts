import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

/** Stable per-instance identity; this module has no SDK or application imports. */
const IN_MEMORY_DB = ':memory:';
let inMemoryNonce: string | null = null;

export function platformInstanceId(): string {
  const configured = process.env.PLATFORM_INSTANCE_ID;
  if (configured !== undefined) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(configured)) {
      throw new Error('PLATFORM_INSTANCE_ID must be a stable 1–64 character instance identifier');
    }
    return configured;
  }
  const dataRoot = process.env.DATA_ROOT ?? resolve(process.cwd(), 'data');
  const db = process.env.DATABASE_URL ?? resolve(dataRoot, 'platform.db');
  if (db === IN_MEMORY_DB) {
    // 惰性生成并缓存：同一个进程内必须恒定，否则打标签与过滤用的会是两个值。
    inMemoryNonce ??= randomBytes(16).toString('hex');
    return createHash('sha256').update(inMemoryNonce).digest('hex').slice(0, 16);
  }
  return createHash('sha256').update(db).digest('hex').slice(0, 16);
}
