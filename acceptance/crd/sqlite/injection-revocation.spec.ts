import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { asCredentialId, asSandboxId } from '@platform/shared-kernel';
import { SqliteUnitOfWork } from '../../../apps/api/src/platform/persistence/unit-of-work.impl';
import { SqliteCredentialSandboxBindingRepository } from '../../../packages/modules/credential/src/infrastructure/persistence/sqlite/credential-sandbox-binding.repository.impl';
import { CredentialSandboxBinding } from '../../../packages/modules/credential/src/domain/entities/credential-sandbox-binding.entity';

function harness() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  const repo = new SqliteCredentialSandboxBindingRepository(db);
  const uow = new SqliteUnitOfWork(sqlite);
  sqlite.exec(
    "INSERT INTO sandboxes (id,project_id,runtime,headless,created_at,updated_at) VALUES ('task','project','codex',0,0,0)",
  );
  function credential(id: string, expiresAt: number | null = null) {
    sqlite
      .prepare(
        "INSERT INTO credentials (id,kind,runtime_id,masked_identifier,encrypted_blob,iv,auth_tag,encryption_key_id,obtained_via,mode,issued_at,expires_at) VALUES (?,'runtime','codex','masked','blob','iv','tag','key','api-key','api-key',0,?)",
      )
      .run(id, expiresAt);
  }
  const binding = (id: string) =>
    CredentialSandboxBinding.record({
      id: `binding-${id}`,
      credentialId: asCredentialId(id),
      sandboxId: asSandboxId('task'),
      now: new Date(1000),
    });
  return { sqlite, repo, uow, credential, binding };
}

describe('CRD 注入台账与撤销事务', () => {
  it('注入只登记准备时的实际凭证，已删/过期/其他Agent拒绝', async () => {
    const h = harness();
    h.credential('old', 10);
    expect(
      h.uow.run((tx) => h.repo.saveIfUsableSync(tx, h.binding('old'), 'codex', new Date(5000))),
    ).toBe(true);
    expect(
      h.uow.run((tx) =>
        h.repo.saveIfUsableSync(tx, h.binding('old'), 'claude-code', new Date(5000)),
      ),
    ).toBe(false);
    expect(
      h.uow.run((tx) => h.repo.saveIfUsableSync(tx, h.binding('old'), 'codex', new Date(10000))),
    ).toBe(false);
    h.sqlite.exec(
      "UPDATE credentials SET revoked_at=6,encrypted_blob=NULL,iv=NULL,auth_tag=NULL WHERE id='old'",
    );
    expect(
      h.uow.run((tx) => h.repo.saveIfUsableSync(tx, h.binding('old'), 'codex', new Date(6000))),
    ).toBe(false);
    expect(await h.repo.listPendingRevocations()).toHaveLength(1);
    h.sqlite.close();
  });
  it('重新登录迁移活动绑定，删除新凭证仍能找到原任务', async () => {
    const h = harness();
    h.credential('old');
    h.uow.run((tx) => h.repo.saveIfUsableSync(tx, h.binding('old'), 'codex', new Date(1000)));
    h.uow.run((tx) => {
      h.sqlite.exec(
        "UPDATE credentials SET revoked_at=2,encrypted_blob=NULL,iv=NULL,auth_tag=NULL WHERE id='old'",
      );
      h.credential('new');
      h.repo.migrateCredentialSync(tx, asCredentialId('old'), asCredentialId('new'));
    });
    expect(await h.repo.listByCredential(asCredentialId('old'))).toHaveLength(0);
    expect((await h.repo.listByCredential(asCredentialId('new')))[0]?.sandboxId).toBe('task');
    expect(await h.repo.listPendingRevocations()).toHaveLength(0);
    h.sqlite.exec(
      "UPDATE credentials SET revoked_at=3,encrypted_blob=NULL,iv=NULL,auth_tag=NULL WHERE id='new'",
    );
    expect((await h.repo.listPendingRevocations())[0]?.credentialId).toBe('new');
    h.sqlite.close();
  });
  it('失败事务保留原凭证和原绑定', async () => {
    const h = harness();
    h.credential('old');
    h.uow.run((tx) => h.repo.saveIfUsableSync(tx, h.binding('old'), 'codex', new Date(1000)));
    expect(() =>
      h.uow.run((tx) => {
        h.sqlite.exec(
          "UPDATE credentials SET revoked_at=2,encrypted_blob=NULL,iv=NULL,auth_tag=NULL WHERE id='old'",
        );
        h.credential('new');
        h.repo.migrateCredentialSync(tx, asCredentialId('old'), asCredentialId('new'));
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(await h.repo.listByCredential(asCredentialId('old'))).toHaveLength(1);
    expect(await h.repo.listPendingRevocations()).toHaveLength(0);
    expect(h.sqlite.prepare("SELECT id FROM credentials WHERE id='new'").get()).toBeUndefined();
    h.sqlite.close();
  });
});
