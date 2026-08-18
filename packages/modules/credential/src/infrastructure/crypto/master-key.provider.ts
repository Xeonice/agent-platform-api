import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Vault master key source (docs/backend/05 §4.2). Priority:
 *   ① env `PLATFORM_MASTER_KEY` (base64, 32 bytes) — production/orchestration;
 *   ② else first-run auto-generate 32 random bytes with `crypto.randomBytes`
 *      (never Math.random), written via `fs.open(path,'wx',0o600)` (EXCLUSIVE
 *      create — closes the "writeFile then chmod leaves a 0644 window" race and a
 *      concurrent-first-boot race; EEXIST ⇒ read the existing key). Parent dir is
 *      `mkdir(0o700)` first; the file is `fsync`-ed before any encryption uses it.
 *
 * `encryptionKeyId` is a STABLE FINGERPRINT of the key (`sha256(key)` truncated),
 * NOT a logical label — so swapping the env key surfaces an authTag mismatch that
 * is diagnosable instead of silently failing.
 *
 * Lazy: nothing touches the filesystem until the first `material()` call, so
 * booting the app merely to emit OpenAPI never writes a key file.
 */
@Injectable()
export class MasterKeyProvider {
  private readonly logger = new Logger('MasterKeyProvider');
  private cached: { key: Buffer; keyId: string } | null = null;

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
    this.logger.warn(
      `已自动生成主密钥 ${path}，请纳入你的备份策略（备份丢失将无法解密已保存的凭证，需重新授权）。`,
    );
    return key;
  }
}
