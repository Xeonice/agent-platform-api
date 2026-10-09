import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteUnitOfWork } from '../../../apps/api/src/platform/persistence/unit-of-work.impl';
import { SqliteImageRepository } from '../../../packages/modules/image/src/infrastructure/persistence/sqlite/image.repository.impl';
import { Image } from '../../../packages/modules/image/src/domain/entities/image.entity';
import { currentDatabase } from '../../support/sqlite';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe('AC-IMG-060.4/060.5/060.6 · real additive migration and persistence', () => {
  it('upgrades an existing images row to nullable alias without changing its identity', async () => {
    const sqlite = new Database(':memory:');
    databases.push(sqlite);
    const migrations = readMigrationFiles({ migrationsFolder: resolve(process.cwd(), 'drizzle') });
    for (const migration of migrations.slice(0, -1)) {
      for (const statement of migration.sql) sqlite.exec(statement);
    }
    sqlite
      .prepare('INSERT INTO images (id,name,is_builtin,created_at) VALUES (?,?,0,0)')
      .run('old', 'registry.test/old');
    expect(sqlite.prepare('PRAGMA table_info(images)').all()).not.toContainEqual(
      expect.objectContaining({ name: 'alias' }),
    );
    for (const statement of migrations.at(-1)!.sql) sqlite.exec(statement);
    expect(sqlite.prepare('SELECT id,name,alias FROM images WHERE id=?').get('old')).toEqual({
      id: 'old',
      name: 'registry.test/old',
      alias: null,
    });
    const repository = new SqliteImageRepository(drizzle(sqlite));
    expect((await repository.findById('old'))?.alias).toBeNull();
  });

  it('reopens alias writes, permits duplicate names and prevents a stale registration upsert from overwriting', async () => {
    const database = currentDatabase();
    databases.push(database.sqlite);
    const repository = new SqliteImageRepository(database.db);
    const image = (id: string) =>
      Image.create({
        id,
        name: `registry.test/${id}`,
        alias: '构建 Agent',
        ownerRef: null,
        isBuiltin: false,
        createdAt: new Date(0),
      });
    database.uow.run((tx) => {
      repository.saveSync(tx, image('one'));
      repository.saveSync(tx, image('two'));
    });
    const stale = await repository.findById('one');
    if (stale === null) throw new Error('image fixture missing');
    database.uow.run((tx) => repository.updateAliasSync(tx, 'one', '新名称'));
    database.uow.run((tx) => repository.saveSync(tx, stale));
    const reopened = new SqliteImageRepository(database.db);
    expect((await reopened.findById('one'))?.alias).toBe('新名称');
    expect((await reopened.findById('two'))?.alias).toBe('构建 Agent');
    const uow = new SqliteUnitOfWork(database.sqlite);
    expect(() =>
      uow.run((tx) => {
        repository.updateAliasSync(tx, 'one', '不能提交');
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect((await reopened.findById('one'))?.alias).toBe('新名称');
  });
});
