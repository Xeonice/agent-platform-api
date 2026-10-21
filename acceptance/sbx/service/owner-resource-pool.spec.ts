import { describe, expect, it } from 'vitest';
import { asNodeId, asSandboxId } from '@platform/shared-kernel';
import type { RuntimeOwnerSchedulingSnapshot } from '@platform/contracts';
import { ResourceAllocation } from '../../../packages/modules/sandbox/src/domain/entities/resource-allocation.entity';
import {
  sandboxOwnerEvidence,
  pendingOwnerPlacement,
  ownerResourcePool,
} from '../../../packages/modules/sandbox/src/application/owner-resource-pool';
const allocation = (id: string, node = 'local') =>
  ResourceAllocation.allocate({
    id,
    sandboxId: asSandboxId(id),
    nodeId: asNodeId(node),
    quota: { cores: 2, ramMb: 2048, diskMb: 10240 },
    now: new Date(0),
  });
const snapshot = (
  assignments: RuntimeOwnerSchedulingSnapshot['assignments'] = [],
): RuntimeOwnerSchedulingSnapshot => ({
  ownerId: 'new',
  observedAt: 0,
  ownerIds: ['old', 'new'],
  helperOwnerId: 'new',
  capacity: {
    cores: 4,
    ramMb: 8192,
    diskTotalBytes: 100 * 1024 ** 3,
    diskAvailableBytes: 80 * 1024 ** 3,
  },
  assignments,
});
const held = [
  { owner: 'auth-helper', label: 'helper', quota: { cores: 1, ramMb: 512, diskMb: 0 } },
];
describe('Owner pool classification preserves uncertainty and retained quotas', () => {
  it('classifies legacy handles readonly and reserves the helper only on its actual Owner', () => {
    const old = allocation('old-task'),
      fresh = allocation('fresh');
    const observed = snapshot([
      { ownerId: 'old', sandboxId: 'old-task', state: 'owned' },
      { ownerId: 'old', sandboxId: 'auth-helper', state: 'owned' },
    ]);
    observed.helperOwnerId = 'old';
    const result = ownerResourcePool(
      observed,
      [old, fresh],
      new Map([
        ['old-task', 'old'],
        ['fresh', 'new'],
      ]),
      held,
    );
    expect(result.selected).toEqual([fresh]);
    expect(result.reservations).toEqual([]);
    expect(old.nodeId).toBe('local');
  });
  it('reserves an absent helper on the current future target and HOLDs a different unconfirmed pin', () => {
    expect(ownerResourcePool(snapshot(), [], new Map(), held).reservations).toEqual(held);
    const observed = snapshot();
    observed.helperOwnerId = 'old';
    expect(() => ownerResourcePool(observed, [], new Map(), held)).toThrow(
      'helper result is unconfirmed',
    );
  });
  it.each(['owned', 'unconfirmed'] as const)(
    'HOLDs an Owner %s assignment with no unique active allocation',
    (state) => {
      expect(() =>
        ownerResourcePool(
          snapshot([{ ownerId: 'old', sandboxId: 'orphan', state }]),
          [],
          new Map(),
          held,
        ),
      ).toThrow('no active quota');
    },
  );
  it('does not drop an unknown legacy allocation or malformed actual handle', () => {
    expect(() => ownerResourcePool(snapshot(), [allocation('unknown')], new Map(), held)).toThrow(
      'unknown or conflicting',
    );
    expect(() =>
      ownerResourcePool(snapshot(), [allocation('broken')], new Map([['broken', null]]), held),
    ).toThrow('handle ownership');
  });
  it('rejects conflicting durable placement, handle and actual Owner inventory', () => {
    expect(() =>
      ownerResourcePool(
        snapshot([{ ownerId: 'old', sandboxId: 'task', state: 'owned' }]),
        [allocation('task')],
        new Map([['task', 'new']]),
        held,
      ),
    ).toThrow('conflicting');
  });
  it('does not infer a usable helper from an unconfirmed create', () => {
    expect(() =>
      ownerResourcePool(
        snapshot([{ ownerId: 'new', sandboxId: 'auth-helper', state: 'unconfirmed' }]),
        [],
        new Map(),
        held,
      ),
    ).toThrow('helper assignment');
  });
  it('keeps planned placement distinct from a real handle and rejects malformed/conflicting evidence', () => {
    expect(
      sandboxOwnerEvidence({
        id: 'logical-task',
        providerSandboxId: null,
        providerState: { runtimeOwnerPlacement: { ownerId: 'new' } },
      }),
    ).toBe('new');
    expect(() =>
      pendingOwnerPlacement({ runtimeOwnerPlacement: { ownerId: 'new', fakeProof: true } }),
    ).toThrow('malformed');
    expect(() =>
      sandboxOwnerEvidence({
        id: 'logical-task',
        providerSandboxId: 'actual',
        providerState: {
          runtimeOwnerPlacement: { ownerId: 'new' },
          runtimeOwner: { ownerId: 'old', sandboxId: 'logical-task' },
        },
      }),
    ).toThrow('conflicts');
    expect(
      sandboxOwnerEvidence({ id: 'logical-task', providerSandboxId: null, providerState: null }),
    ).toBeUndefined();
  });

  it('does not classify a same-Owner handle for a different logical sandbox as valid capacity evidence', () => {
    const evidence = sandboxOwnerEvidence({
      id: 'expected-task',
      providerSandboxId: 'actual-native-id',
      providerState: { runtimeOwner: { ownerId: 'new', sandboxId: 'different-task' } },
    });
    expect(evidence).toBeNull();
    if (evidence !== null) throw new Error('The malformed handle must be explicitly unknown');
    expect(() =>
      ownerResourcePool(
        snapshot(),
        [allocation('expected-task')],
        new Map([['expected-task', evidence]]),
        held,
      ),
    ).toThrow('handle ownership');
  });
});
