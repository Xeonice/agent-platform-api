/** Actual durable writer epoch, not a process-local flag or readiness claim. */
export interface BusinessWriterAuthority {
  assert(): void;
  epoch?(): number;
  /** Capture the actual admitted epoch for the whole asynchronous use case. */
  run?<T>(work: () => T): T;
}
export const BUSINESS_WRITER_AUTHORITY = Symbol('BusinessWriterAuthority');
