import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { SqliteUnitOfWork } from '../../apps/api/src/platform/persistence/unit-of-work.impl';

/** Current production schema only: the product has never been deployed. */
export function currentDatabase() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  return { sqlite, db, uow: new SqliteUnitOfWork(sqlite) };
}

export function seedImageManifest(
  sqlite: Database.Database,
  options: { imageId?: string; manifestId?: string; name?: string; digest?: string } = {},
): string {
  const id = options.manifestId ?? 'manifest-default';
  let imageId = options.imageId ?? `image-${id}`;
  const name = options.name ?? `registry.test/${id}`;
  sqlite
    .prepare('INSERT OR IGNORE INTO images (id,name,is_builtin,created_at) VALUES (?,?,0,0)')
    .run(imageId, name);
  imageId = (sqlite.prepare('SELECT id FROM images WHERE name=?').get(name) as { id: string }).id;
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO image_manifests
    (id,image_id,version,base_image,digest,entrypoint_contract,supported_runtimes,resource_defaults,labels_required,validation_status,is_active,registered_at)
    VALUES (?,?,?,?,?,'{}','[]','{}','[]','valid',1,0)`,
    )
    .run(id, imageId, id, name, options.digest ?? `sha256:${'a'.repeat(64)}`);
  return id;
}
