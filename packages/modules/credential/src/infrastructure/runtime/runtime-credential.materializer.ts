import { Inject, Injectable } from '@nestjs/common';
import { CRYPTO_SERVICE } from '../../domain/ports/crypto.port';
import type { CryptoService } from '../../domain/ports/crypto.port';
import type {
  MaterializeRuntimeInput,
  MaterializedRuntimeCredential,
  RuntimeCredentialMaterializer,
  RuntimeSecretPayload,
} from '../../domain/ports/runtime-credential-materializer.port';

/**
 * Runtime credential materializer (05 §4, out-口 discipline 23 §8.3): decrypt →
 * parse the `RuntimeSecretPayload` from the plaintext Buffer → assemble a controlled
 * -plaintext `MaterializedRuntimeCredential` → zeroize the cipher Buffer. The
 * plaintext strings live only in the returned wrapper; `zeroize()` best-effort drops
 * them (JS strings are immutable — the real wipe is the cipher Buffer here + the
 * `SecretMaterial.zeroize()` below; the token never enters argv/logs, P1-5).
 */
@Injectable()
export class DefaultRuntimeCredentialMaterializer implements RuntimeCredentialMaterializer {
  constructor(@Inject(CRYPTO_SERVICE) private readonly crypto: CryptoService) {}

  async materialize(input: MaterializeRuntimeInput): Promise<MaterializedRuntimeCredential> {
    const secret = await this.crypto.decrypt(input.secret); // throws DecryptionError
    let payload: RuntimeSecretPayload;
    try {
      payload = secret.use((buf) => JSON.parse(buf.toString('utf8')) as RuntimeSecretPayload);
    } finally {
      secret.zeroize();
    }

    const out: MaterializedRuntimeCredential = {
      runtimeId: input.runtimeId,
      obtainedVia: input.obtainedVia,
      maskedIdentifier: input.maskedIdentifier,
      issuedAt: input.issuedAt.toISOString(),
      expiresAt: input.expiresAt ? input.expiresAt.toISOString() : undefined,
      credentialFiles: payload.credentialFiles ?? [],
      env: payload.env,
      accessToken: payload.accessToken,
      authFile: payload.authFile,
      zeroize(): void {
        // Best-effort: drop references so nothing survives past use (JS strings are
        // immutable; the true wipe already happened on the cipher Buffer above).
        for (const f of out.credentialFiles) f.content = '';
        out.credentialFiles = [];
        out.env = undefined;
        out.accessToken = undefined;
        out.authFile = undefined;
      },
    };
    return out;
  }
}
