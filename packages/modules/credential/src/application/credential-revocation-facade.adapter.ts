import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, UNIT_OF_WORK, asCredentialId, asSandboxId } from '@platform/shared-kernel';
import type { Clock, UnitOfWork } from '@platform/shared-kernel';
import { CREDENTIAL_SANDBOX_BINDING_REPOSITORY } from '../domain/repositories/credential-sandbox-binding.repository';
import type { CredentialSandboxBindingRepository } from '../domain/repositories/credential-sandbox-binding.repository';
import type {
  CredentialRevocationBindingRef,
  CredentialRevocationFacade,
} from './credential-revocation.facade';

@Injectable()
export class CredentialRevocationFacadeAdapter implements CredentialRevocationFacade {
  constructor(
    @Inject(CREDENTIAL_SANDBOX_BINDING_REPOSITORY)
    private readonly bindings: CredentialSandboxBindingRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async listPendingRevocations(): Promise<readonly CredentialRevocationBindingRef[]> {
    return this.references(await this.bindings.listPendingRevocations());
  }

  async listForRevokedCredential(
    credentialId: string,
  ): Promise<readonly CredentialRevocationBindingRef[]> {
    return this.references(
      await this.bindings.listPendingRevocations(asCredentialId(credentialId)),
    );
  }

  async confirmCleared(binding: CredentialRevocationBindingRef): Promise<boolean> {
    return Promise.resolve(
      this.uow.run((tx) =>
        this.bindings.markClearedSync(
          tx,
          {
            id: binding.bindingId,
            credentialId: asCredentialId(binding.credentialId),
            sandboxId: asSandboxId(binding.sandboxId),
          },
          this.clock.now(),
        ),
      ),
    );
  }

  private references(
    bindings: readonly { id: string; credentialId: string; sandboxId: string }[],
  ): readonly CredentialRevocationBindingRef[] {
    return bindings.map((binding) =>
      Object.freeze({
        bindingId: binding.id,
        credentialId: binding.credentialId,
        sandboxId: binding.sandboxId,
      }),
    );
  }
}
