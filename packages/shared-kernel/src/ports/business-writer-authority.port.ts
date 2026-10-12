/** Actual durable writer epoch, not a process-local flag or readiness claim. */
export interface BusinessWriterAuthority {
  assert(): void;
  epoch?(): number;
}
export const BUSINESS_WRITER_AUTHORITY = Symbol('BusinessWriterAuthority');
