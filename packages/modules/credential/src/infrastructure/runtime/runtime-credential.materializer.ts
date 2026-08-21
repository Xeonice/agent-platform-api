import { Inject, Injectable } from '@nestjs/common';
import { CRYPTO_SERVICE } from '../../domain/ports/crypto.port';
import type { CryptoService } from '../../domain/ports/crypto.port';
import { MissingPlatformAuthFileError } from '../../domain/ports/runtime-credential-materializer.port';
import type {
  MaterializeRuntimeInput,
  MaterializedRefreshCredential,
  MaterializedRuntimeCredential,
  RuntimeCredentialMaterializer,
  RuntimeSecretPayload,
} from '../../domain/ports/runtime-credential-materializer.port';

/**
 * Runtime credential materializer (05 §4, out-口 discipline 23 §8.3): decrypt → parse
 * the `RuntimeSecretPayload` from the plaintext Buffer → assemble a controlled
 * -plaintext wrapper → zeroize the cipher Buffer. The plaintext strings live only in
 * the returned wrapper; `zeroize()` best-effort drops them (JS strings are immutable —
 * the real wipe is the cipher Buffer here + the `SecretMaterial.zeroize()` below; the
 * token never enters argv/logs, P1-5).
 *
 * ★ 裁决 D-18 (05 §4.3): the two paths are assembled by two methods.
 * `materializeForInjection` NEVER reads `payload.authFile` — the real `refresh_token`
 * is not carried past this line for the injection path, so no downstream branch can
 * leak it. `materializeForRefresh` is the single place that does read it, and its
 * result is typed so that only the refresh scanner accepts it.
 */
@Injectable()
export class DefaultRuntimeCredentialMaterializer implements RuntimeCredentialMaterializer {
  constructor(@Inject(CRYPTO_SERVICE) private readonly crypto: CryptoService) {}

  async materializeForInjection(
    input: MaterializeRuntimeInput,
  ): Promise<MaterializedRuntimeCredential> {
    const payload = await this.decryptPayload(input);
    return this.assembleInjectable(input, payload);
  }

  async materializeForRefresh(
    input: MaterializeRuntimeInput,
  ): Promise<MaterializedRefreshCredential> {
    const payload = await this.decryptPayload(input);
    const authFile = payload.authFile;
    if (authFile === undefined || authFile.length === 0) {
      throw new MissingPlatformAuthFileError(`runtime credential for ${input.runtimeId}`);
    }
    const injectable = this.assembleInjectable(input, payload);
    // Spreading copies the FIELDS, so `out` needs its own wipe — delegating to the
    // injectable's `zeroize()` would clear that object's references, not this one's.
    const out: MaterializedRefreshCredential = {
      ...injectable,
      authFile,
      zeroize(): void {
        for (const f of out.credentialFiles) f.content = '';
        out.credentialFiles = [];
        out.env = undefined;
        out.accessToken = undefined;
        out.authFile = '';
      },
    };
    return out;
  }

  private async decryptPayload(input: MaterializeRuntimeInput): Promise<RuntimeSecretPayload> {
    const secret = await this.crypto.decrypt(input.secret); // throws DecryptionError
    try {
      return secret.use((buf) => JSON.parse(buf.toString('utf8')) as RuntimeSecretPayload);
    } finally {
      secret.zeroize();
    }
  }

  /**
   * Assemble the injectable half. `payload.authFile` is intentionally NOT referenced
   * anywhere in this method — that absence IS the guarantee (I-CRD-9).
   */
  private assembleInjectable(
    input: MaterializeRuntimeInput,
    payload: RuntimeSecretPayload,
  ): MaterializedRuntimeCredential {
    const out: MaterializedRuntimeCredential = {
      runtimeId: input.runtimeId,
      obtainedVia: input.obtainedVia,
      maskedIdentifier: input.maskedIdentifier,
      issuedAt: input.issuedAt.toISOString(),
      expiresAt: input.expiresAt ? input.expiresAt.toISOString() : undefined,
      credentialFiles: (payload.credentialFiles ?? []).map((f) => ({ ...f })),
      env: payload.env,
      accessToken: payload.accessToken,
      zeroize(): void {
        // Best-effort: drop references so nothing survives past use (JS strings are
        // immutable; the true wipe already happened on the cipher Buffer above).
        for (const f of out.credentialFiles) f.content = '';
        out.credentialFiles = [];
        out.env = undefined;
        out.accessToken = undefined;
      },
    };
    return out;
  }
}
