import { describe, expect, it, vi } from 'vitest';
import { RuntimeReconciler } from '../../../packages/modules/sandbox/src/infrastructure/reconcile/runtime-reconciler';
import {
  INSTANCE_LABEL,
  platformInstanceId,
  boxliteNamePrefix,
} from '../../../packages/modules/sandbox/src/infrastructure/reconcile/instance-id';

const boxes = vi.hoisted(() => ({
  list: [] as { id: string; name: string }[],
  removed: [] as string[],
}));
vi.mock(
  '../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-runtime',
  () => ({
    getSharedBoxliteRuntime: async () => ({
      listInfo: async () => boxes.list,
      remove: async (id: string) => {
        boxes.removed.push(id);
      },
    }),
  }),
);

describe('reconcile terminated or unbound runtime instances within this platform instance', () => {
  it('reaps crashed-create and terminal instances, preserves stopped/running and foreign instances', async () => {
    const rows = [
      { id: 'unbound', handle: null, status: 'creating' },
      { id: 'failed', handle: 'failed-instance', status: 'failed' },
      { id: 'deleted', handle: 'deleted-instance', status: 'destroyed' },
      { id: 'paused', handle: 'paused-instance', status: 'stopped' },
      { id: 'running', handle: 'running-instance', status: 'running' },
    ];
    const db = { select: () => ({ from: () => ({ all: () => rows }) }) };
    const removed: string[] = [];
    const mine = platformInstanceId();
    const containers = [
      ...rows.map((row) => ({
        Id: row.id,
        Names: [row.id],
        Labels: { 'platform.sandboxId': row.id, [INSTANCE_LABEL]: mine },
      })),
      {
        Id: 'foreign',
        Names: ['foreign'],
        Labels: { 'platform.sandboxId': 'other', [INSTANCE_LABEL]: 'another-instance' },
      },
    ];
    const docker = {
      listContainers: async () => containers,
      getContainer: (id: string) => ({
        remove: async () => {
          removed.push(id);
        },
      }),
    };
    boxes.list = [
      ...rows.map((row) => ({ id: row.id, name: `${boxliteNamePrefix()}${row.id}` })),
      { id: 'foreign', name: 'platform-boxlite-another-instance-other' },
    ];
    boxes.removed = [];
    const reconciler = new RuntimeReconciler(db as never, docker as never);
    expect(await reconciler.reconcile()).toEqual({ removedContainers: 3, removedBoxes: 3 });
    expect(removed).toEqual(['unbound', 'failed', 'deleted']);
    expect(boxes.removed).toEqual(['unbound', 'failed', 'deleted']);
  });
});
