import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import type { Tx } from '@platform/shared-kernel';
import { Image } from '../../../domain/entities/image.entity';
import type { ImageRepository } from '../../../domain/repositories/image.repository';
import { images, type ImageRow } from '../schema/image.sqlite';

type Db = BetterSQLite3Database<Record<string, never>>;

/**
 * SQLite `ImageRepository`. Writes are synchronous and run inside the caller's
 * `UnitOfWork` — the `Tx` parameter is unused at runtime but is what makes 「this
 * write is inside a transaction」 a TYPE-level fact rather than a convention (P2-1).
 */
@Injectable()
export class SqliteImageRepository implements ImageRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async findById(id: string): Promise<Image | null> {
    const row = this.db.select().from(images).where(eq(images.id, id)).get();
    return row ? toDomain(row) : null;
  }

  async findByName(name: string): Promise<Image | null> {
    const row = this.db.select().from(images).where(eq(images.name, name)).get();
    return row ? toDomain(row) : null;
  }

  async list(): Promise<Image[]> {
    return this.db.select().from(images).all().map(toDomain);
  }

  saveSync(_tx: Tx, image: Image): void {
    this.db
      .insert(images)
      .values({
        id: image.id,
        name: image.name,
        ownerRef: image.ownerRef,
        isBuiltin: image.isBuiltin,
        createdAt: image.createdAt,
      })
      .onConflictDoUpdate({
        target: images.id,
        set: { name: image.name, ownerRef: image.ownerRef, isBuiltin: image.isBuiltin },
      })
      .run();
  }

  deleteSync(_tx: Tx, id: string): void {
    this.db.delete(images).where(eq(images.id, id)).run();
  }
}

function toDomain(row: ImageRow): Image {
  return Image.rehydrate({
    id: row.id,
    name: row.name,
    ownerRef: row.ownerRef,
    isBuiltin: row.isBuiltin,
    createdAt: row.createdAt,
  });
}
