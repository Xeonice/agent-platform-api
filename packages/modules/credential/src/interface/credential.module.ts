import { Global, Module } from '@nestjs/common';
import { CREDENTIAL_FACADE } from '@platform/contracts';
import { CREDENTIAL_REPOSITORY } from '../domain/repositories/credential.repository';
import { CREDENTIAL_SANDBOX_BINDING_REPOSITORY } from '../domain/repositories/credential-sandbox-binding.repository';
import { CRYPTO_SERVICE } from '../domain/ports/crypto.port';
import { GIT_AUTH_MATERIALIZER } from '../domain/ports/git-auth-materializer.port';
import { GIT_REMOTE_TESTER } from '../domain/ports/git-remote-tester.port';
import { RUNTIME_CREDENTIAL_MATERIALIZER } from '../domain/ports/runtime-credential-materializer.port';
import { CredentialApplicationService } from '../application/credential-application.service';
import { CredentialFacadeAdapter } from '../application/credential-facade.adapter';
import { RuntimeCredentialService } from '../application/runtime-credential.service';
import { SqliteCredentialRepository } from '../infrastructure/persistence/sqlite/credential.repository.impl';
import { SqliteCredentialSandboxBindingRepository } from '../infrastructure/persistence/sqlite/credential-sandbox-binding.repository.impl';
import { AesGcmCrypto } from '../infrastructure/crypto/aes-gcm.crypto';
import { MasterKeyProvider } from '../infrastructure/crypto/master-key.provider';
import { FsGitAuthMaterializer } from '../infrastructure/git/git-auth.materializer';
import { GitLsRemoteTester } from '../infrastructure/git/git-ls-remote.tester';
import { KeyfileBootSweeper } from '../infrastructure/git/keyfile-boot-sweeper';
import { DefaultRuntimeCredentialMaterializer } from '../infrastructure/runtime/runtime-credential.materializer';
import { CredentialController } from './http/credential.controller';

/**
 * Composition root for the credential context (01) — the ONE place ports are
 * bound. @Global so the cross-context `CREDENTIAL_FACADE` reaches the project
 * clone workflow without a package cycle (the token is a contracts symbol; the
 * impl is wired here), mirroring PROJECT_FACADE / SANDBOX_FACADE. Registers the
 * keyfile boot sweeper (crash fallback for temp SSH keyfiles).
 */
@Global()
@Module({
  controllers: [CredentialController],
  providers: [
    CredentialApplicationService,
    RuntimeCredentialService,
    CredentialFacadeAdapter,
    MasterKeyProvider,
    KeyfileBootSweeper,
    { provide: CREDENTIAL_REPOSITORY, useClass: SqliteCredentialRepository },
    {
      provide: CREDENTIAL_SANDBOX_BINDING_REPOSITORY,
      useClass: SqliteCredentialSandboxBindingRepository,
    },
    { provide: CRYPTO_SERVICE, useClass: AesGcmCrypto },
    { provide: GIT_AUTH_MATERIALIZER, useClass: FsGitAuthMaterializer },
    { provide: GIT_REMOTE_TESTER, useClass: GitLsRemoteTester },
    { provide: RUNTIME_CREDENTIAL_MATERIALIZER, useClass: DefaultRuntimeCredentialMaterializer },
    { provide: CREDENTIAL_FACADE, useExisting: CredentialFacadeAdapter },
  ],
  exports: [
    CredentialApplicationService,
    RuntimeCredentialService,
    CREDENTIAL_FACADE,
    CREDENTIAL_SANDBOX_BINDING_REPOSITORY,
  ],
})
export class CredentialModule {}
