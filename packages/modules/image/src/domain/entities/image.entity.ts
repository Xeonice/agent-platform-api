import { AggregateRoot } from '@platform/shared-kernel';
import { ImageNotDeletableError } from '../errors/image-errors';

export interface ImageProps {
  id: string;
  /** Repository name WITHOUT a version (`ghcr.io/agent-infra/sandbox`), UNIQUE. */
  name: string;
  ownerRef: string | null;
  isBuiltin: boolean;
  createdAt: Date;
}

/**
 * `Image` — the light aggregate (23 §9.1 裁决 D-8): a NAMED GROUPING of manifests,
 * nothing more. Cards in the UI aggregate by this row; versions live on
 * `ImageManifest`, which is the root anything outside this context references.
 */
export class Image extends AggregateRoot<string> {
  readonly name: string;
  readonly ownerRef: string | null;
  readonly isBuiltin: boolean;
  readonly createdAt: Date;

  private constructor(props: ImageProps) {
    super(props.id);
    this.name = props.name;
    this.ownerRef = props.ownerRef;
    this.isBuiltin = props.isBuiltin;
    this.createdAt = props.createdAt;
  }

  static create(props: ImageProps): Image {
    return new Image(props);
  }

  static rehydrate(props: ImageProps): Image {
    return new Image(props);
  }

  /**
   * I-IMG-4: a built-in image may be DISABLED, never deleted.
   *
   * ⚠️ THE FK IS THE OTHER HALF, NOT A SUBSTITUTE. `sandboxes.image_ref RESTRICT`
   * stops the delete of an image some Task still points at; this stops the delete of a
   * built-in image nobody has used yet — a case the FK cannot see.
   */
  assertDeletable(): void {
    if (this.isBuiltin) {
      throw new ImageNotDeletableError(
        `image '${this.name}' is built-in: it can be disabled (PATCH { isActive: false }) but not deleted (I-IMG-4)`,
      );
    }
  }
}
