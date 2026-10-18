import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import {
  CREDENTIAL_REVOCATION_FACADE,
  type CredentialRevocationFacade,
} from '@platform/credential';
import { PLATFORM_SQLITE } from '../../../apps/api/src/platform/persistence/platform.module';
import { createPlatform } from '../../support/platform-app';

let platform: Awaited<ReturnType<typeof createPlatform>>;
beforeAll(async () => {
  platform = await createPlatform();
});
afterAll(async () => {
  await platform?.close();
});

describe('HTTP credential revocation uses the owning credential application boundary', () => {
  it('destroys an already stopped bound instance outside the ledger transaction and confirms only its binding', async () => {
    const http = request(platform.app.getHttpServer());
    const project = await http
      .post('/api/projects')
      .send({ name: 'revocation', sourceType: 'empty' })
      .expect(202);
    const created = await http
      .post('/api/sandboxes')
      .send({ projectId: project.body.id, runtime: 'claude-code' })
      .expect(201);
    const id = String(created.body.id);
    await vi.waitFor(async () =>
      expect((await http.get(`/api/sandboxes/${id}`).expect(200)).body.status).toBe('running'),
    );
    await http.post(`/api/sandboxes/${id}/stop`).expect(200);
    expect((await http.get(`/api/sandboxes/${id}`).expect(200)).body.status).toBe('stopped');

    const sqlite = platform.app.get<Database.Database>(PLATFORM_SQLITE);
    sqlite
      .prepare(
        `INSERT INTO credentials
      (id,kind,runtime_id,masked_identifier,encrypted_blob,iv,auth_tag,encryption_key_id,obtained_via,mode,issued_at)
      VALUES ('cleanup-credential','runtime','claude-code','masked','synthetic-blob','iv','tag','key','setup-token','account',0)`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO credential_sandbox_bindings (id,credential_id,sandbox_id,injected_at)
      VALUES ('cleanup-binding','cleanup-credential',?,0)`,
      )
      .run(id);
    const facade = platform.app.get<CredentialRevocationFacade>(CREDENTIAL_REVOCATION_FACADE);
    expect(await facade.listPendingRevocations()).toEqual([]);

    let removed = '';
    platform.provider.destroy = async (handle) => {
      expect(sqlite.inTransaction).toBe(false);
      removed = handle.providerSandboxId;
    };
    await http.delete('/api/runtimes/claude-code/credentials/cleanup-credential').expect(204);
    await vi.waitFor(async () => {
      expect(
        sqlite
          .prepare('SELECT revoked_at FROM credential_sandbox_bindings WHERE id=?')
          .get('cleanup-binding'),
      ).toMatchObject({ revoked_at: expect.any(Number) });
      expect(removed).toBe(`instance-${id}`);
    });
    expect(await facade.listForRevokedCredential('cleanup-credential')).toEqual([]);
    expect(
      sqlite
        .prepare('SELECT revoked_at,encrypted_blob,iv,auth_tag FROM credentials WHERE id=?')
        .get('cleanup-credential'),
    ).toMatchObject({
      revoked_at: expect.any(Number),
      encrypted_blob: null,
      iv: null,
      auth_tag: null,
    });
    expect(sqlite.prepare('SELECT status FROM sandboxes WHERE id=?').get(id)).toEqual({
      status: 'destroyed',
    });
    await http.delete('/api/runtimes/claude-code/credentials/cleanup-credential').expect(204);
  });
});
