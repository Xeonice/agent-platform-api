import { isRecord } from '@platform/shared-kernel';
import { requireUpgrade } from './upgrade-trust';

/** Unknown JSON/RPC values stay unknown until their container shape is checked.
 * Consumers must still validate the specific identity, binding and field values. */
export function upgradeRecord(value: unknown): Record<string, unknown> {
  requireUpgrade(isRecord(value), 'INVALID_JSON', 400);
  return value;
}

export function upgradeRecords(value: unknown): Record<string, unknown>[] {
  requireUpgrade(Array.isArray(value), 'INVALID_JSON', 400);
  return value.map((entry: unknown) => upgradeRecord(entry));
}

export function optionalUpgradeRecord(value: unknown): Record<string, unknown> | undefined {
  return value === undefined || value === null ? undefined : upgradeRecord(value);
}

export function nullableUpgradeRecord(value: unknown): Record<string, unknown> | null {
  return value === null || value === undefined ? null : upgradeRecord(value);
}

/** SQL get() has a real missing-row outcome even for an expected singleton. */
export function requiredUpgradeValue<T>(value: T | null | undefined): T {
  requireUpgrade(value !== null && value !== undefined, 'INVALID_JSON', 400);
  return value;
}
