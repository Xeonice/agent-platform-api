import { Injectable, Logger } from '@nestjs/common';
import { MasterKeySource } from '@platform/shared-kernel';

/**
 * Nest-injectable wrapper over the shared `MasterKeySource` (docs/backend/05 §4.2).
 *
 * ⚠️ THE LOADING RULES MOVED TO `shared-kernel`, THE INJECTION POINT DID NOT. The
 * image context also encrypts at rest (`secret: true` env values, 13 §2.4.3), and
 * `eslint-plugin-boundaries` forbids it from reaching into this module's
 * infrastructure — so the primitive had to become shared. What stays here is the DI
 * registration and the one-time 「back up this key」 warning.
 */
@Injectable()
export class MasterKeyProvider {
  private readonly logger = new Logger('MasterKeyProvider');
  private readonly source = new MasterKeySource((path) => {
    this.logger.warn(
      `已自动生成主密钥 ${path}，请纳入你的备份策略（备份丢失将无法解密已保存的凭证，需重新授权）。`,
    );
  });

  material(): { key: Buffer; keyId: string } {
    return this.source.material();
  }
}
