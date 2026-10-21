import type { ProjectReadProjection } from '@platform/project';
import type { UpgradeOnlineMigration } from './upgrade-online-migration';

/** Signed build declaration comes from this actual production provider factory.
 * Runtime candidates must additionally prove the same live DI adapter methods. */
export const UPGRADE_PROJECT_DATA_FORMATS = Object.freeze(['project-name-v2-authority']);
export function createUpgradeProjectProjection(
  migration: UpgradeOnlineMigration,
): ProjectReadProjection {
  return {
    name: (id, original) => migration.projectedProjectName(id, original),
    authoritative: () => migration.projectNameAuthoritative(),
    findIdByName: (name) => migration.projectIdByName(name),
    saveNameSync: (_tx, id, name) => migration.saveProjectName(id, name),
  };
}
