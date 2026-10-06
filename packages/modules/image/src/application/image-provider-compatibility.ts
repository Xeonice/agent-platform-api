import { builtinImageRefFor } from '@platform/shared-kernel';
import { parseImageRef } from '@platform/contracts';
import type { ImageManifest } from '../domain/entities/image-manifest.entity';
import type { ImageRepository } from '../domain/repositories/image.repository';
import type { ImageManifestRepository } from '../domain/repositories/image-manifest.repository';

/** One lineage rule for the task-image list and the create door (AC-LCH-004.10). */
export async function imageProviderCompatibility(
  images: ImageRepository,
  manifests: ImageManifestRepository,
  provider: string,
): Promise<(manifest: ImageManifest) => boolean> {
  const anchor = await images.findByName(parseImageRef(builtinImageRefFor(provider)).name);
  // Missing anchor cannot prove incompatibility; keep the door's existing degradation.
  if (anchor === null) return () => true;
  const digests = new Set((await manifests.listByImage(anchor.id)).map((m) => m.digest));
  return (manifest) =>
    manifest.imageId === anchor.id ||
    (manifest.derivedFromDigest !== null && digests.has(manifest.derivedFromDigest));
}
