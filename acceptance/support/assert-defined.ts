/** Fail at the fixture precondition instead of silently skipping missing evidence. */
export function assertDefined<T>(
  value: T,
  message = 'Expected fixture value to exist',
): NonNullable<T> {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
