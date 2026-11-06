/** Narrow external values before reading their fields. Arrays are separate values. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Rejections need not be Error instances. Keep diagnostics safe for unknown values. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
