import { describe, expect, it } from 'vitest';
import { asCredentialId, asSandboxId } from '@platform/shared-kernel';
import { CredentialRevokedHandler } from '../../../packages/modules/sandbox/src/application/event-handlers/credential-revoked.handler';
import { SqliteCredentialSandboxBindingRepository } from '../../../packages/modules/credential/src/infrastructure/persistence/sqlite/credential-sandbox-binding.repository.impl';
import { CredentialSandboxBinding } from '../../../packages/modules/credential/src/domain/entities/credential-sandbox-binding.entity';
import { CredentialRevoked } from '../../../packages/modules/credential/src/domain/events/credential-events';
import { harness, waitForStatus } from '../../support/sandbox-rig';

describe('revoked binding survives failed teardown and a fresh handler recovers it', () => {
  it('retains a durable pending binding until the provider instance is actually removed', async () => {
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    h.sqlite
      .prepare(
        `INSERT INTO credentials (id,kind,runtime_id,masked_identifier,encrypted_blob,iv,auth_tag,encryption_key_id,obtained_via,mode,issued_at)
      VALUES ('credential','runtime','claude-code','masked','synthetic-blob','iv','tag','key','setup-token','account',0)`,
      )
      .run();
    const bindings = new SqliteCredentialSandboxBindingRepository(h.db);
    const binding = CredentialSandboxBinding.record({
      id: 'binding',
      credentialId: asCredentialId('credential'),
      sandboxId: asSandboxId(dto.id),
      now: h.clock.now(),
    });
    h.uow.run((tx) => bindings.saveSync(tx, binding));
    h.sqlite
      .prepare(
        "UPDATE credentials SET revoked_at=1,encrypted_blob=NULL,iv=NULL,auth_tag=NULL WHERE id='credential'",
      )
      .run();
    h.provider.destroy = async () => {
      throw new Error('provider offline');
    };
    const createHandler = () =>
      new CredentialRevokedHandler(h.events, bindings, h.repo, h.uow, h.clock, h.service);
    await createHandler().onRevoked(
      new CredentialRevoked(binding.credentialId, 'claude-code', 'setup-token', h.clock.now()),
    );
    expect(await bindings.listPendingRevocations()).toHaveLength(1);
    expect((await bindings.listByCredential(binding.credentialId))[0].isCleared()).toBe(false);
    let removals = 0;
    h.provider.destroy = async () => {
      removals++;
    };
    const recovered = createHandler();
    await recovered.retryPending();
    await recovered.retryPending();
    expect(await bindings.listPendingRevocations()).toEqual([]);
    expect((await bindings.listByCredential(binding.credentialId, true))[0].isCleared()).toBe(true);
    expect((await h.repo.findById(asSandboxId(dto.id)))?.status).toBe('destroyed');
    expect(removals).toBe(1);
  });
});
