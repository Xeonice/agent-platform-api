/** Shared pure policy: validate raw input before trimming (REQ-IMG-060). */
export class ImageAliasValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageAliasValidationError';
  }
}

export function normalizeImageAlias(value: string | null): string | null {
  if (value === null) return null;
  if (/[\p{Cc}\u2028\u2029]/u.test(value)) {
    throw new ImageAliasValidationError('别名不能包含换行或控制字符');
  }
  const normalized = value.trim();
  if ([...normalized].length > 64) {
    throw new ImageAliasValidationError('别名最多 64 个字符');
  }
  return normalized === '' ? null : normalized;
}
