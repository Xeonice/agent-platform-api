import { afterEach, describe, expect, it } from 'vitest';
import { asCredentialId, asSandboxId } from '@platform/shared-kernel';
import type { CredentialRevocationBindingRef } from '@platform/credential';
import { CredentialRevocationFacadeAdapter } from '../../../packages/modules/credential/src/application/credential-revocation-facade.adapter';
import { CredentialSandboxBinding } from '../../../packages/modules/credential/src/domain/entities/credential-sandbox-binding.entity';
import { SqliteCredentialSandboxBindingRepository } from '../../../packages/modules/credential/src/infrastructure/persistence/sqlite/credential-sandbox-binding.repository.impl';
import { currentDatabase } from '../../support/sqlite';

const close: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of close.splice(0).reverse()) cleanup();
});

// Real initialization migrations, production repository and synchronous SQLite UoW.
// Synthetic credentials never leave this isolated in-memory database.
function fixture() {
  const { sqlite, db, uow } = currentDatabase();
  close.push(() => sqlite.close());
  const repo = new SqliteCredentialSandboxBindingRepository(db);
  let time = 10_000;
  const clock = { now: () => new Date(time) };
  const facade = new CredentialRevocationFacadeAdapter(repo, uow, clock);

  function credential(id: string, revoked = false) {
    sqlite
      .prepare(
        `INSERT INTO credentials
          (id,kind,runtime_id,masked_identifier,encrypted_blob,iv,auth_tag,encryption_key_id,obtained_via,mode,issued_at,revoked_at)
         VALUES (?,'runtime',?,'masked',?,?,?,'fixture-key','api-key','api-key',0,?)`,
      )
      .run(
        id,
        `runtime-${id}`,
        revoked ? null : 'synthetic-ciphertext',
        revoked ? null : 'synthetic-iv',
        revoked ? null : 'synthetic-auth-tag',
        revoked ? 1 : null,
      );
  }
  function binding(bindingId: string, credentialId: string, sandboxId: string) {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO sandboxes (id,project_id,runtime,headless,created_at,updated_at)
         VALUES (?,'fixture-project','codex',0,0,0)`,
      )
      .run(sandboxId);
    uow.run((tx) =>
      repo.saveSync(
        tx,
        CredentialSandboxBinding.record({
          id: bindingId,
          credentialId: asCredentialId(credentialId),
          sandboxId: asSandboxId(sandboxId),
          now: new Date(1000),
        }),
      ),
    );
    return { bindingId, credentialId, sandboxId } satisfies CredentialRevocationBindingRef;
  }
  async function clearedAt(credentialId: string, bindingId: string) {
    const rows = await repo.listByCredential(asCredentialId(credentialId), true);
    const found = rows.find((row) => row.id === bindingId);
    expect(found, 'fixture binding must exist before checking its cleared timestamp').toBeDefined();
    return found?.revokedAt;
  }
  function revoke(credentialId: string) {
    sqlite
      .prepare(
        'UPDATE credentials SET revoked_at=2,encrypted_blob=NULL,iv=NULL,auth_tag=NULL WHERE id=?',
      )
      .run(credentialId);
  }
  return {
    sqlite,
    db,
    uow,
    repo,
    clock,
    facade,
    credential,
    binding,
    clearedAt,
    revoke,
    setTime: (next: number) => {
      time = next;
    },
  };
}

describe('credential revocation application facade over the production SQLite ledger', () => {
  it('returns only immutable three-ID references for revoked, uncleared bindings', async () => {
    const h = fixture();
    h.credential('active');
    h.credential('revoked', true);
    h.credential('already-cleared', true);
    h.binding('active-binding', 'active', 'active-task');
    const expected = h.binding('pending-binding', 'revoked', 'pending-task');
    const cleared = h.binding('cleared-binding', 'already-cleared', 'cleared-task');
    expect(await h.facade.confirmCleared(cleared)).toBe(true);

    const all = await h.facade.listPendingRevocations();
    expect(all).toEqual([expected]);
    const scoped = await h.facade.listForRevokedCredential('revoked');
    expect(scoped).toEqual([expected]);
    expect(await h.facade.listForRevokedCredential('active')).toEqual([]);
    expect(await h.facade.listForRevokedCredential('missing')).toEqual([]);
    expect(await h.facade.listForRevokedCredential('already-cleared')).toEqual([]);
    for (const ref of [...all, ...scoped]) {
      expect(Reflect.ownKeys(ref).sort()).toEqual(['bindingId', 'credentialId', 'sandboxId']);
      expect(Object.getPrototypeOf(ref)).toBe(Object.prototype);
      expect(Object.isFrozen(ref)).toBe(true);
      expect(Reflect.set(ref, 'sandboxId', 'other-task')).toBe(false);
      expect(ref).toEqual(expected);
    }
    expect(await h.facade.listPendingRevocations()).toEqual([expected]);
  });

  it('rejects confirmation of an active credential even when all three IDs match', async () => {
    const h = fixture();
    h.credential('active');
    const ref = h.binding('binding', 'active', 'task');
    expect(await h.facade.listPendingRevocations()).toEqual([]);
    expect(await h.facade.confirmCleared(ref)).toBe(false);
    expect(await h.clearedAt('active', 'binding')).toBeNull();
    h.revoke('active');
    expect(await h.facade.listPendingRevocations()).toEqual([ref]);
  });

  it.each([
    { field: 'bindingId', replacement: 'binding-b' },
    { field: 'credentialId', replacement: 'credential-b' },
    { field: 'sandboxId', replacement: 'task-b' },
  ] as const)(
    'rejects an existing but mismatched $field without clearing either row',
    async (change) => {
      const h = fixture();
      h.credential('credential-a', true);
      h.credential('credential-b', true);
      const first = h.binding('binding-a', 'credential-a', 'task-a');
      h.binding('binding-b', 'credential-b', 'task-b');
      expect(await h.facade.confirmCleared({ ...first, [change.field]: change.replacement })).toBe(
        false,
      );
      expect(await h.clearedAt('credential-a', 'binding-a')).toBeNull();
      expect(await h.clearedAt('credential-b', 'binding-b')).toBeNull();
      expect(await h.facade.listPendingRevocations()).toHaveLength(2);
    },
  );

  it('rejects a stale reference after migration, including when the new credential is revoked later', async () => {
    const h = fixture();
    h.credential('previous', true);
    h.credential('next');
    const original = h.binding('same-binding', 'previous', 'same-task');
    const stale = (await h.facade.listForRevokedCredential('previous'))[0];
    expect(stale).toEqual(original);
    if (!stale) throw new Error('expected the original pending reference');
    h.uow.run((tx) =>
      h.repo.migrateCredentialSync(tx, asCredentialId('previous'), asCredentialId('next')),
    );
    expect(await h.facade.confirmCleared(stale)).toBe(false);
    expect(await h.facade.listForRevokedCredential('previous')).toEqual([]);
    expect(await h.facade.listPendingRevocations()).toEqual([]);

    h.revoke('next');
    const replacement = { ...original, credentialId: 'next' };
    expect(await h.facade.listPendingRevocations()).toEqual([replacement]);
    expect(await h.facade.confirmCleared(stale)).toBe(false);
    expect(await h.clearedAt('next', 'same-binding')).toBeNull();
    expect(await h.facade.confirmCleared(replacement)).toBe(true);
  });

  it('clears only the exact pending row and preserves its first timestamp on duplicate confirmation', async () => {
    const h = fixture();
    h.credential('shared', true);
    const target = h.binding('target', 'shared', 'target-task');
    const neighbor = h.binding('neighbor', 'shared', 'neighbor-task');
    expect(await h.facade.confirmCleared(target)).toBe(true);
    expect(await h.clearedAt('shared', 'target')).toEqual(new Date(10_000));
    expect(await h.clearedAt('shared', 'neighbor')).toBeNull();

    h.setTime(20_000);
    expect(await h.facade.confirmCleared(target)).toBe(false);
    expect(await h.clearedAt('shared', 'target')).toEqual(new Date(10_000));
    expect(await h.facade.listPendingRevocations()).toEqual([neighbor]);
  });

  it('rolls back a real post-update SQLite failure and a fresh facade recovers the pending row', async () => {
    const h = fixture();
    h.credential('revoked', true);
    const ref = h.binding('target', 'revoked', 'task');
    // FAIL in an AFTER trigger occurs after the row update. The production UoW
    // must roll it back; merely swallowing the SQL exception would lose recovery.
    h.sqlite.exec(`CREATE TRIGGER fail_confirmation AFTER UPDATE OF revoked_at
      ON credential_sandbox_bindings WHEN NEW.id='target'
      BEGIN SELECT RAISE(FAIL,'fixture confirmation write failed'); END`);
    await expect(h.facade.confirmCleared(ref)).rejects.toThrow('fixture confirmation write failed');
    expect(await h.clearedAt('revoked', 'target')).toBeNull();
    expect(await h.facade.listPendingRevocations()).toEqual([ref]);

    h.sqlite.exec('DROP TRIGGER fail_confirmation');
    const recovered = new CredentialRevocationFacadeAdapter(
      new SqliteCredentialSandboxBindingRepository(h.db),
      h.uow,
      h.clock,
    );
    const pending = await recovered.listPendingRevocations();
    expect(pending).toEqual([ref]);
    expect(await recovered.confirmCleared(ref)).toBe(true);
    expect(await recovered.listPendingRevocations()).toEqual([]);
    expect(await h.clearedAt('revoked', 'target')).toEqual(new Date(10_000));
  });
});
