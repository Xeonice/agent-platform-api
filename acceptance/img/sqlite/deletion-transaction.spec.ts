import { afterEach, describe, expect, it } from 'vitest';
import { SqliteImageManifestRepository } from '../../../packages/modules/image/src/infrastructure/persistence/sqlite/image-manifest.repository.impl';
import { currentDatabase, seedImageManifest } from '../../support/sqlite';

const databases: ReturnType<typeof currentDatabase>[] = [];
function scenario() {
  const database = currentDatabase();
  databases.push(database);
  const manifest = seedImageManifest(database.sqlite);
  const repository = new SqliteImageManifestRepository(database.db);
  const task = (id: string, status: string) =>
    database.sqlite
      .prepare(
        `INSERT INTO sandboxes
    (id,project_id,runtime,image_ref,status,headless,created_at,updated_at)
    VALUES (?,'project','codex',?,?,0,0,0)`,
      )
      .run(id, manifest, status);
  return { ...database, manifest, repository, task };
}
afterEach(() => databases.splice(0).forEach(({ sqlite }) => sqlite.close()));

describe('AC-IMG-034.3/034.4 · current-schema delete transaction', () => {
  it('deletes the manifest while detaching only destroyed references and preserving their task records', async () => {
    const s = scenario();
    s.task('destroyed-task', 'destroyed');
    expect(await s.repository.countReferencingSandboxes(s.manifest)).toBe(0);
    s.uow.run((tx) => s.repository.deleteSync(tx, s.manifest));
    expect(await s.repository.findById(s.manifest)).toBeNull();
    expect(
      s.sqlite.prepare('SELECT image_ref,status FROM sandboxes WHERE id=?').get('destroyed-task'),
    ).toEqual({ image_ref: null, status: 'destroyed' });
    expect(s.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('rechecks references in the delete transaction when a stopped task appears after the preview, with no partial detach', async () => {
    const s = scenario();
    s.task('destroyed-task', 'destroyed');
    expect(await s.repository.countReferencingSandboxes(s.manifest)).toBe(0);
    s.task('stopped-task', 'stopped');
    expect(() => s.uow.run((tx) => s.repository.deleteSync(tx, s.manifest))).toThrow(/含已停止/);
    expect(await s.repository.findById(s.manifest)).not.toBeNull();
    expect(s.sqlite.prepare('SELECT id,image_ref FROM sandboxes ORDER BY id').all()).toEqual([
      { id: 'destroyed-task', image_ref: s.manifest },
      { id: 'stopped-task', image_ref: s.manifest },
    ]);
    expect(s.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
});
