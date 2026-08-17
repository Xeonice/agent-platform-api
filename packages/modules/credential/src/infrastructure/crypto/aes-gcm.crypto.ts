import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { CryptoService } from '../../domain/ports/crypto.port';
import { DecryptionError } from '../../domain/ports/crypto.port';
import { EncryptedBlob } from '../../domain/value-objects/encrypted-blob.vo';
import { SecretMaterial } from '../../domain/value-objects/secret-material.vo';
import { MasterKeyProvider } from './master-key.provider';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * AES-256-GCM CryptoService (docs/backend/05 §4). Encrypt lends the plaintext
 * Buffer from `SecretMaterial` (never a string); decrypt returns a Buffer wrapped
 * back into `SecretMaterial`. An authTag mismatch or an unavailable key throws
 * `DecryptionError` (never a 500 — 05 §4.2: the credential is presented as
 * revoked). The ciphertext is stamped with the current key fingerprint (`keyId`)
 * to support rotation.
 */
@Injectable()
export class AesGcmCrypto implements CryptoService {
  constructor(private readonly masterKey: MasterKeyProvider) {}

  async encrypt(plain: SecretMaterial): Promise<EncryptedBlob> {
    const { key, keyId } = this.masterKey.material();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const blob = plain.use((buf) => Buffer.concat([cipher.update(buf), cipher.final()]));
    const authTag = cipher.getAuthTag();
    return new EncryptedBlob(
      blob.toString('base64'),
      iv.toString('base64'),
      authTag.toString('base64'),
      keyId,
    );
  }

  async decrypt(blob: EncryptedBlob): Promise<SecretMaterial> {
    try {
      const { key } = this.masterKey.material();
      const decipher = createDecipheriv(ALGO, key, Buffer.from(blob.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(blob.authTag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(blob.blob, 'base64')),
        decipher.final(),
      ]);
      return SecretMaterial.fromBuffer(plain);
    } catch (e) {
      throw new DecryptionError((e as Error).message);
    }
  }
}
