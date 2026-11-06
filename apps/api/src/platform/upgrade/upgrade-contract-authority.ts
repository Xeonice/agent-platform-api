import type Database from 'better-sqlite3';
export const CONTRACT_ROLE = 'project-name-contract';
export function contractFenceFloor(sqlite: Database.Database, instance: string): number {
  return (
    sqlite
      .prepare<unknown[], { n: number }>(
        'SELECT fence AS n FROM platform_operations WHERE instance_id=? AND role=? ORDER BY fence DESC LIMIT 1',
      )
      .get(instance, CONTRACT_ROLE)?.n ?? 0
  );
}
export function contractActive(sqlite: Database.Database, instance: string): boolean {
  return Boolean(
    sqlite
      .prepare(
        "SELECT 1 FROM platform_operations WHERE instance_id=? AND role=? AND state IN ('accepted','retiring-readers','authority-active','clearing')",
      )
      .get(instance, CONTRACT_ROLE),
  );
}
