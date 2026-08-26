import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { MasterKeySource } from '@platform/shared-kernel';
import type { EnvSecretCipher, SealedEnvValue } from '../../domain/ports/env-secret.cipher.port';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * Field-level AES-256-GCM for `secret: true` env values (13 §2.4.3, 23 I-IMG-5).
 *
 * ⚠️ IT REUSES THE VAULT'S MASTER KEY, VIA THE SHARED `MasterKeySource`, ON PURPOSE.
 * The alternative — a second key with its own file, its own rotation and its own
 * backup story — doubles the number of ways a restore can leave the platform holding
 * ciphertext it can no longer read, in exchange for isolating two secret stores that
 * are already protected by the same process.
 *
 * `keyId` is stamped into every blob so a rotated key produces a DIAGNOSABLE authTag
 * mismatch rather than a silent wrong answer.
 */
@Injectable()
export class AesGcmEnvSecretCipher implements EnvSecretCipher {
  private readonly logger = new Logger('EnvSecretCipher');
  private readonly keys = new MasterKeySource((path) => {
    this.logger.warn(`已自动生成主密钥 ${path}，请纳入你的备份策略。`);
  });

  seal(plain: string): SealedEnvValue {
    const { key, keyId } = this.keys.material();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const blob = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
    return {
      blob: blob.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyId,
    };
  }

  open(sealed: SealedEnvValue): string {
    const { key } = this.keys.material();
    const decipher = createDecipheriv(ALGO, key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.blob, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
