import { afterEach, describe, it, expect, vi } from 'vitest';
import { asSandboxId } from '@platform/shared-kernel';
import type { Clock, DomainEvent, EventBus, Tx, UnitOfWork } from '@platform/shared-kernel';
import type {
  CredentialSandboxBinding,
  CredentialSandboxBindingRepository,
} from '@platform/credential';
import { CredentialRevokedHandler } from '../../src/application/event-handlers/credential-revoked.handler';

/**
 * Unit coverage for the sandbox-side revoke coordinator (05 §4 P0-4, P0-1/P1-b). This
 * is the most security-critical code in S4 — a revoked credential MUST tear down every
 * live sandbox it was injected into, must not be blocked by one wedged container, and
 * must not mark a binding cleared unless the teardown actually happened.
 */
const NOW = new Date('2026-08-21T00:00:00.000Z');
const CRED = 'cred-1';

// The handler only reads `.id` + `.sandboxId`; a minimal shape cast to the entity type
// avoids depending on the type-only export of the entity class.
function binding(id: string, sandboxId: string): CredentialSandboxBinding {
  return { id, sandboxId: asSandboxId(sandboxId) } as never;
}

interface Harness {
  handler: CredentialRevokedHandler;
  destroyCalls: Array<{ id: string; force: boolean }>;
  clearedIds: string[];
}

function harness(opts: {
  bound: Binding[];
  statusOf?: (sandboxId: string) => string | null; // null ⇒ sandbox not found
  destroy?: (id: string, force: boolean) => Promise<void>;
}): Harness {
  const destroyCalls: Array<{ id: string; force: boolean }> = [];
  const clearedIds: string[] = [];

  const bindings: CredentialSandboxBindingRepository = {
    findActive: async () => null,
    listBySandbox: async () => [],
    listByCredential: async (): Promise<CredentialSandboxBinding[]> => opts.bound,
    saveSync: () => {},
    markClearedSync: (_tx: Tx, id: string) => clearedIds.push(id),
  };

  const statusOf = opts.statusOf ?? (() => 'running');
  const sandboxes = {
    findById: async (id: string) => {
      const status = statusOf(id);
      return status === null ? null : { status };
    },
    findByProject: async () => [],
    countActiveByProject: async () => ({}),
    saveSync: () => {},
  } as never;

  const app = {
    destroy: async (id: string, input: { force?: boolean } = {}) => {
      const force = input.force ?? false;
      destroyCalls.push({ id, force });
      if (opts.destroy) return opts.destroy(id, force);
      return undefined;
    },
  } as never;

  const uow: UnitOfWork = { run: (fn) => fn({} as Tx) };
  const events: EventBus = { publishInTx: () => {}, subscribe: () => {} };
  const clock: Clock = { now: () => NOW };

  const handler = new CredentialRevokedHandler(events, bindings, sandboxes, uow, clock, app);
  return { handler, destroyCalls, clearedIds };
}

function revoked(credentialId = CRED): DomainEvent {
  return { type: 'CredentialRevoked', credentialId } as never;
}

describe('CredentialRevokedHandler (05 §4 revoke coordination)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('force-destroys a LIVE bound sandbox and marks the binding cleared', async () => {
    const h = harness({ bound: [binding('b1', 's1')], statusOf: () => 'running' });
    await h.handler.onRevoked(revoked());
    expect(h.destroyCalls).toEqual([{ id: 's1', force: false }]);
    expect(h.clearedIds).toEqual(['b1']);
  });

  it('a git revoke (ZERO bindings) is a no-op — no destroy, no error, no clear', async () => {
    const h = harness({ bound: [] });
    await expect(h.handler.onRevoked(revoked())).resolves.toBeUndefined();
    expect(h.destroyCalls).toEqual([]);
    expect(h.clearedIds).toEqual([]);
  });

  it('a non-live / already-gone sandbox is not destroyed but IS cleared', async () => {
    const h = harness({
      bound: [binding('b1', 's1'), binding('b2', 's2')],
      statusOf: (id) => (id === 's1' ? 'destroyed' : null),
    });
    await h.handler.onRevoked(revoked());
    expect(h.destroyCalls).toEqual([]); // neither is live
    expect(h.clearedIds.sort()).toEqual(['b1', 'b2']);
  });

  it('escalates a FAILED graceful destroy to a force destroy, then clears', async () => {
    const h = harness({
      bound: [binding('b1', 's1')],
      destroy: async (_id, force) => {
        if (!force) throw new Error('graceful teardown failed');
        return undefined; // force succeeds
      },
    });
    await h.handler.onRevoked(revoked());
    expect(h.destroyCalls).toEqual([
      { id: 's1', force: false },
      { id: 's1', force: true },
    ]);
    expect(h.clearedIds).toEqual(['b1']);
  });

  it('does NOT clear a binding when even the force destroy fails (kept for retry, P1-b)', async () => {
    const h = harness({
      bound: [binding('b1', 's1')],
      destroy: async () => {
        throw new Error('container wedged');
      },
    });
    await h.handler.onRevoked(revoked());
    expect(h.destroyCalls.map((c) => c.force)).toEqual([false, true]); // tried both
    expect(h.clearedIds).toEqual([]); // binding retained
  });

  it('one wedged binding does not block the others (concurrent, independent)', async () => {
    const h = harness({
      bound: [binding('b1', 's1'), binding('b2', 's2'), binding('b3', 's3')],
      destroy: async (id) => {
        if (id === 's2') throw new Error('s2 wedged (both graceful + force)');
        return undefined;
      },
    });
    await h.handler.onRevoked(revoked());
    // s1 + s3 cleared; s2 kept for retry
    expect(h.clearedIds.sort()).toEqual(['b1', 'b3']);
  });

  it('escalates to force when the graceful destroy TIMES OUT (hangs)', async () => {
    vi.useFakeTimers();
    const h = harness({
      bound: [binding('b1', 's1')],
      destroy: (_id, force) =>
        force ? Promise.resolve() : new Promise<void>(() => {}) /* never resolves */,
    });
    const p = h.handler.onRevoked(revoked());
    // advance past the graceful budget (20s) so withTimeout rejects → force path runs.
    await vi.advanceTimersByTimeAsync(21_000);
    await p;
    expect(h.destroyCalls).toEqual([
      { id: 's1', force: false },
      { id: 's1', force: true },
    ]);
    expect(h.clearedIds).toEqual(['b1']);
  });
});
