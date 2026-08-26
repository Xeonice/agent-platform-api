import type { Tx } from '@platform/shared-kernel';
import type { Image } from '../entities/image.entity';

export interface ImageRepository {
  findById(id: string): Promise<Image | null>;
  findByName(name: string): Promise<Image | null>;
  list(): Promise<Image[]>;
  /** Synchronous write INSIDE the caller's UnitOfWork (28 §7.3: no `await` in a tx). */
  saveSync(tx: Tx, image: Image): void;
  deleteSync(tx: Tx, id: string): void;
}

export const IMAGE_REPOSITORY = Symbol('ImageRepository');
