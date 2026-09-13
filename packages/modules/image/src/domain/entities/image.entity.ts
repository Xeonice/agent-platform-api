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
        // ⚠️ 这句话会原样上屏（`ImageDeleteRefusedError` 透传 message）。
        //    ⛔ 不写 `PATCH { isActive: false }`：用户手上只有一颗 [禁用] 按钮。
        `'${this.name}' 是平台自带的预制镜像，不能删除 —— 删掉它平台就再也建不出任务了。` +
          '不想让它出现在新任务的下拉里的话，点 [禁用]。',
      );
    }
  }
}
