import type Database from 'better-sqlite3';

/**
 * Insert an `images` + `image_manifests` pair and return the MANIFEST id — the value
 * `sandboxes.image_ref` must now hold (13 §2.4.5).
 *
 * ⚠️ THESE TESTS USED TO PUT A COORDINATE (`ghcr.io/agent-infra/sandbox:latest`) IN
 * THAT COLUMN AND PASS. They pass no longer, and that is the point: 0010 turned the
 * column into a real foreign key, so a coordinate there is now a constraint violation
 * rather than a silently different meaning for the same field.
 */
export function seedImageManifest(
  sqlite: Database.Database,
  opts: { imageId?: string; manifestId?: string; name?: string; digest?: string } = {},
): string {
  const imageId = opts.imageId ?? 'img-int-1';
  const manifestId = opts.manifestId ?? 'imf-int-1';
  const name = opts.name ?? 'ghcr.io/agent-infra/sandbox';
  const digest = opts.digest ?? `sha256:${'a'.repeat(64)}`;
  sqlite
    .prepare('INSERT INTO images (id, name, is_builtin, created_at) VALUES (?, ?, 0, 0)')
    .run(imageId, name);
  sqlite
    .prepare(
      `INSERT INTO image_manifests
         (id, image_id, version, base_image, digest, entrypoint_contract, supported_runtimes,
          resource_defaults, labels_required, validation_status, is_active, registered_at)
       VALUES (?, ?, 'latest', ?, ?, '{}', '[]', '{}', '[]', 'valid', 1, 0)`,
    )
    .run(manifestId, imageId, name, digest);
  return manifestId;
}
