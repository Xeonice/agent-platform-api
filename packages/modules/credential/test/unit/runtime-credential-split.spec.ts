import { describe, it, expect } from 'vitest';
import { RUNTIME_REFRESH_TOKEN_PLACEHOLDER } from '@platform/shared-kernel';
import { DefaultRuntimeCredentialMaterializer } from '../../src/infrastructure/runtime/runtime-credential.materializer';
import { MissingPlatformAuthFileError } from '../../src/domain/ports/runtime-credential-materializer.port';
import type {
  MaterializeRuntimeInput,
  RuntimeSecretPayload,
} from '../../src/domain/ports/runtime-credential-materializer.port';
import type { CryptoService } from '../../src/domain/ports/crypto.port';
import { SecretMaterial } from '../../src/domain/value-objects/secret-material.vo';
import { EncryptedBlob } from '../../src/domain/value-objects/encrypted-blob.vo';

const REAL_REFRESH = 'REAL-REFRESH-TOKEN-that-the-platform-can-never-revoke-upstream';

/** The SANITIZED file the adapter produced at credential birth (05 §4.3 ②). */
const SANITIZED_AUTH_JSON = JSON.stringify({
  tokens: { access_token: 'ACCESS', refresh_token: RUNTIME_REFRESH_TOKEN_PLACEHOLDER },
});
/** The COMPLETE file the vault also stores — platform-only, refresh scanner only. */
const PLATFORM_AUTH_JSON = JSON.stringify({
  tokens: { access_token: 'ACCESS', refresh_token: REAL_REFRESH },
});

const STORED_PAYLOAD: RuntimeSecretPayload = {
  credentialFiles: [
    { containerPath: '~/.codex/auth.json', content: SANITIZED_AUTH_JSON, mode: '0600' },
  ],
  accessToken: 'ACCESS',
  authFile: PLATFORM_AUTH_JSON,
};

/** A crypto stub that "decrypts" straight back to the payload under test. */
function cryptoReturning(payload: RuntimeSecretPayload): CryptoService {
  return {
    encrypt: async () => new EncryptedBlob('blob', 'iv', 'tag', 'key'),
    decrypt: async () => SecretMaterial.fromUtf8(JSON.stringify(payload)),
  };
}

function inputFor(): MaterializeRuntimeInput {
  return {
    runtimeId: 'codex',
    obtainedVia: 'oauth-device',
    maskedIdentifier: 'codex:…1234',
    issuedAt: new Date('2026-08-20T00:00:00Z'),
    expiresAt: null,
    secret: new EncryptedBlob('blob', 'iv', 'tag', 'key'),
  };
}

/**
 * T-CRD-17/18/19 (25 §3.4) — the credential-side half of I-CRD-9. The refresh token is
 * kept out of the injection path here, at the vault edge; the contracts testkit's
 * RA-15/16/17 then prove the adapter never leaks what it IS handed. Together the two
 * cover the whole `prepareRuntimeCredential → injectCredential` path.
 */
describe('runtime credential injection/refresh split (05 §4.3 裁决 D-18)', () => {
  it('T-CRD-17: the injection out-口 has NO authFile — structurally, not by convention', async () => {
    const materializer = new DefaultRuntimeCredentialMaterializer(cryptoReturning(STORED_PAYLOAD));
    const cred = await materializer.materializeForInjection(inputFor());

    expect(Object.keys(cred)).not.toContain('authFile');
    // ...and the type says so too, which is the part a future refactor cannot erode:
    // @ts-expect-error `authFile` does not exist on MaterializedRuntimeCredential (I-CRD-9)
    expect(cred.authFile).toBeUndefined();
  });

  it('T-CRD-17: the REFRESH out-口 does carry it (the split is a split, not a deletion)', async () => {
    const materializer = new DefaultRuntimeCredentialMaterializer(cryptoReturning(STORED_PAYLOAD));
    const refreshable = await materializer.materializeForRefresh(inputFor());
    expect(refreshable.authFile).toBe(PLATFORM_AUTH_JSON);
    expect(refreshable.authFile).toContain(REAL_REFRESH);
  });

  it('T-CRD-18: the stored record HAS the real token, yet the injectable form has no trace of it', async () => {
    // The dangerous case by construction: the vault really is holding a full auth.json.
    expect(JSON.stringify(STORED_PAYLOAD)).toContain(REAL_REFRESH);

    const materializer = new DefaultRuntimeCredentialMaterializer(cryptoReturning(STORED_PAYLOAD));
    const cred = await materializer.materializeForInjection(inputFor());

    expect(JSON.stringify(cred)).not.toContain(REAL_REFRESH);
    const injected = JSON.parse(cred.credentialFiles[0].content) as {
      tokens?: { refresh_token?: string };
    };
    // exactly the placeholder: not missing (codex refuses to start), not empty
    expect(injected.tokens?.refresh_token).toBe(RUNTIME_REFRESH_TOKEN_PLACEHOLDER);
  });

  it('T-CRD-19: containerPath stays `~/`-relative — nothing here may expand $HOME', async () => {
    // `prepareRuntimeCredential(runtimeId)` has no sandbox and no `exec` in reach; the
    // expansion belongs to `injectCredential` alone (裁决 D-19).
    const materializer = new DefaultRuntimeCredentialMaterializer(cryptoReturning(STORED_PAYLOAD));
    const cred = await materializer.materializeForInjection(inputFor());
    for (const file of cred.credentialFiles) {
      expect(file.containerPath.startsWith('~/')).toBe(true);
      expect(file.containerPath.startsWith('/')).toBe(false);
    }
  });

  it('a credential with no platform auth file cannot be refreshed (typed as present ⇒ must throw)', async () => {
    const apiKeyOnly: RuntimeSecretPayload = { env: { OPENAI_API_KEY: 'sk-x' } };
    const materializer = new DefaultRuntimeCredentialMaterializer(cryptoReturning(apiKeyOnly));
    await expect(materializer.materializeForRefresh(inputFor())).rejects.toBeInstanceOf(
      MissingPlatformAuthFileError,
    );
    // the injection path is unaffected — it never wanted an auth file in the first place
    await expect(materializer.materializeForInjection(inputFor())).resolves.toMatchObject({
      env: { OPENAI_API_KEY: 'sk-x' },
    });
  });

  it('zeroize() on the refreshable form wipes the platform auth file too', async () => {
    const materializer = new DefaultRuntimeCredentialMaterializer(cryptoReturning(STORED_PAYLOAD));
    const refreshable = await materializer.materializeForRefresh(inputFor());
    refreshable.zeroize();
    expect(refreshable.authFile).toBe('');
    expect(refreshable.credentialFiles).toHaveLength(0);
  });
});
