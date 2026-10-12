import { AsyncLocalStorage } from 'node:async_hooks';

/** One admitted application operation keeps the writer epoch with which it
 * began, even if its original process is later retained and reactivated. */
export interface BusinessWriterEpoch {
  instanceId: string;
  generation: number;
  fence: number;
}
const context = new AsyncLocalStorage<BusinessWriterEpoch>();
export function currentBusinessWriterEpoch(): BusinessWriterEpoch | undefined {
  return context.getStore();
}
export function withBusinessWriterEpoch<T>(epoch: BusinessWriterEpoch, work: () => T): T {
  return context.run(Object.freeze({ ...epoch }), work);
}
