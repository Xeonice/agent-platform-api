import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Vault master key source (docs/backend/05 §4.2). Priority:
 *   ① env `PLATFORM_MASTER_KEY` (base64, 32 bytes) — production/orchestration;
 *   ② else first-run auto-generate 32 random bytes with `crypto.randomBytes`
 *      (never Math.random), written via `fs.open(path,'wx',0o600)` (EXCLUSIVE
 *      create — closes the "writeFile then chmod leaves a 0644 window" race and a
 *      concurrent-first-boot race; EEXIST ⇒ read the existing key). Parent dir is
 *      `mkdir(0o700)` first; the file is `fsync`-ed before any encryption uses it.
 *
 * `keyId` is a STABLE FINGERPRINT of the key (`sha256(key)` truncated), NOT a
 * logical label — so swapping the env key surfaces an authTag mismatch that is
 * diagnosable instead of silently failing.
 *
 * ⚠️ IT LIVES IN `shared-kernel` BECAUSE TWO CONTEXTS ENCRYPT AT REST: credential
 * (the Vault) and image (`secret: true` env values, 13 §2.4.3). Two copies would be
 * two answers to 「where is the master key」, and the day they disagree one context's
 * ciphertext is unreadable forever. Each context keeps its own Nest-injectable
 * wrapper; only this primitive is shared, so `shared-kernel` still owes nothing to
 * NestJS.
 *
 * Lazy: nothing touches the filesystem until the first `material()` call, so
 * booting the app merely to emit OpenAPI never writes a key file.
 */
export class MasterKeySource {
  private cached: { key: Buffer; keyId: string } | null = null;

  /** Invoked once, with the new key file's path, when a key had to be generated. */
  constructor(private readonly onGenerated?: (path: string) => void) {}

  material(): { key: Buffer; keyId: string } {
    if (this.cached) return this.cached;
    const key = this.loadKey();
    if (key.length !== 32) {
      throw new Error('master key must be exactly 32 bytes (AES-256)');
    }
    const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16);
    this.cached = { key, keyId };
    return this.cached;
  }

  private loadKey(): Buffer {
    const fromEnv = process.env.PLATFORM_MASTER_KEY;
    if (fromEnv && fromEnv.trim().length > 0) {
      return Buffer.from(fromEnv.trim(), 'base64');
    }
    return this.loadOrGenerateFile();
  }

  private keyPath(): string {
    const dataRoot = process.env.DATA_ROOT ?? resolve(process.cwd(), 'data');
    return resolve(dataRoot, '.master.key');
  }

  private loadOrGenerateFile(): Buffer {
    const path = this.keyPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600); // exclusive create
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        return readFileSync(path);
      }
      throw e;
    }
    try {
      writeSync(fd, key);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.onGenerated?.(path);
    return key;
  }
}
