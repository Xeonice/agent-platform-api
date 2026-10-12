import type Database from 'better-sqlite3';
export const CONTRACT_ROLE = 'project-name-contract';
export function contractFenceFloor(sqlite: Database.Database, instance: string): number {
  return (
    sqlite
      .prepare(
        'SELECT coalesce(max(fence),0) n FROM platform_operations WHERE instance_id=? AND role=?',
      )
      .get(instance, CONTRACT_ROLE) as { n: number }
  ).n;
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
