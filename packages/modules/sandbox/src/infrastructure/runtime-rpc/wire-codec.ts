import { isRecord } from '@platform/shared-kernel';
/** JSON control messages retain binary bytes; streams use a separate response. */
export function encodeOwnerValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { $ownerBytes: value.toString('base64') };
  if (value === undefined) return { $ownerUndefined: true };
  if (Array.isArray(value)) return value.map(encodeOwnerValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encodeOwnerValue(item)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new Error('Non-finite owner value');
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error('Owner RPC accepts data, not executable values');
  }
  return value;
}

export function decodeOwnerValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeOwnerValue);
  if (isRecord(value)) {
    const record = value;
    if (Object.keys(record).length === 1 && typeof record.$ownerBytes === 'string') {
      const bytes = Buffer.from(record.$ownerBytes, 'base64');
      if (bytes.toString('base64') !== record.$ownerBytes)
        throw new Error('Invalid owner binary encoding');
      return bytes;
    }
    if (Object.keys(record).length === 1 && record.$ownerUndefined === true) return undefined;
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, decodeOwnerValue(item)]),
    );
  }
  return value;
}

export function ownerRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected owner record');
  return value;
}
