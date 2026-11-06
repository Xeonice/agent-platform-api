import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { RuntimeOwnerFence } from '@platform/contracts';

export interface RuntimeBusinessAuthority {
  /** Persisted command, run or automation occurrence identity, never a retry nonce. */
  operationId: string;
  actor: RuntimeOwnerFence['actor'];
}
const authority = new AsyncLocalStorage<RuntimeBusinessAuthority>();

export function withRuntimeBusinessAuthority<T>(
  context: RuntimeBusinessAuthority,
  work: () => T,
): T {
  return authority.run(context, work);
}

export function runtimeBusinessAuthority(): RuntimeBusinessAuthority {
  return (
    authority.getStore() ?? {
      operationId: `system-${randomBytes(20).toString('hex')}`,
      actor: { kind: 'system', id: 'state-coordinator' },
    }
  );
}

export function explicitRuntimeBusinessAuthority(): RuntimeBusinessAuthority | undefined {
  return authority.getStore();
}
