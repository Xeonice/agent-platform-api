import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeReconciler } from '../../../packages/modules/sandbox/src/infrastructure/reconcile/runtime-reconciler';
import {
  INSTANCE_LABEL,
  platformInstanceId,
  boxliteNamePrefix,
} from '../../../packages/modules/sandbox/src/infrastructure/reconcile/instance-id';

const boxes = vi.hoisted(() => ({
  list: [] as { id: string; name: string; state?: { status: string; running: boolean } }[],
  removed: [] as string[],
  removeError: null as Error | null,
}));
vi.mock(
  '../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-runtime',
  () => ({
    getSharedBoxliteRuntime: async () => ({
      listInfo: async () => boxes.list,
      remove: async (id: string) => {
        if (boxes.removeError) throw boxes.removeError;
        boxes.removed.push(id);
      },
    }),
  }),
);
afterEach(() => {
  boxes.removeError = null;
});
afterEach(() => vi.restoreAllMocks());

const rows = [
  { id: 'unbound', handle: null, status: 'creating' },
  { id: 'failed', handle: 'failed-instance', status: 'failed' },
  { id: 'deleted', handle: 'deleted-instance', status: 'destroyed' },
  { id: 'paused', handle: 'paused-instance', status: 'stopped' },
  { id: 'running', handle: 'running-instance', status: 'running' },
];
const db = { select: () => ({ from: () => ({ all: () => rows }) }) };
function docker(
  containers: { Id: string; Names: string[]; Labels: Record<string, string>; State?: string }[],
) {
  const removed: string[] = [];
  return {
    removed,
    client: {
      listContainers: async () => containers,
      getContainer: (id: string) => ({
        remove: async () => {
          removed.push(id);
        },
      }),
    },
  };
}

describe('reconcile terminated or unbound runtime instances within this platform instance', () => {
  it('reaps crashed-create and terminal instances, preserves stopped/running and foreign instances', async () => {
    const mine = platformInstanceId();
    const d = docker([
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
    ]);
    boxes.list = [
      ...rows.map((row) => ({ id: row.id, name: `${boxliteNamePrefix()}${row.id}` })),
      { id: 'foreign', name: 'platform-boxlite-another-instance-other' },
    ];
    boxes.removed = [];
    const reconciler = new RuntimeReconciler(db as never, d.client as never);
    expect(await reconciler.reconcile()).toEqual({ removedContainers: 3, removedBoxes: 3 });
    expect(d.removed).toEqual(['unbound', 'failed', 'deleted']);
    expect(boxes.removed).toEqual(['unbound', 'failed', 'deleted']);
  });
});

describe('the platform auth helper is never an orphan; only a dead leftover is cleared', () => {
  it.each([
    ['running', true, false],
    ['configured', false, false],
    ['stopping', false, false],
    ['stopped', false, true],
    ['failed', false, true],
  ])(
    'a BoxLite helper that is %s (running=%s) is removed: %s',
    async (status, running, removed) => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      boxes.list = [
        { id: 'helper-box', name: `${boxliteNamePrefix()}auth-helper`, state: { status, running } },
      ];
      boxes.removed = [];
      const reconciler = new RuntimeReconciler(db as never, docker([]).client as never);
      expect(await reconciler.reconcile()).toEqual({
        removedContainers: 0,
        removedBoxes: removed ? 1 : 0,
      });
      expect(boxes.removed).toEqual(removed ? ['helper-box'] : []);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('ORPHAN');
      if (removed)
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining(
            `removed stale platform auth helper ${boxliteNamePrefix()}auth-helper`,
          ),
        );
    },
  );

  it.each([
    ['running', false],
    ['created', false],
    ['exited', true],
    ['dead', true],
  ])('a docker helper container that is %s is removed: %s', async (state, removed) => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    boxes.list = [];
    const d = docker([
      {
        Id: 'helper-container',
        Names: ['/platform-aio-auth-helper'],
        Labels: { 'platform.sandboxId': 'auth-helper', [INSTANCE_LABEL]: platformInstanceId() },
        State: state,
      },
    ]);
    const reconciler = new RuntimeReconciler(db as never, d.client as never);
    expect(await reconciler.reconcile()).toEqual({
      removedContainers: removed ? 1 : 0,
      removedBoxes: 0,
    });
    expect(d.removed).toEqual(removed ? ['helper-container'] : []);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('ORPHAN');
  });

  it('a stopped helper of another platform instance is left alone', async () => {
    boxes.list = [
      {
        id: 'foreign-helper',
        name: 'platform-boxlite-another-instance-auth-helper',
        state: { status: 'stopped', running: false },
      },
    ];
    boxes.removed = [];
    const reconciler = new RuntimeReconciler(db as never, docker([]).client as never);
    expect(await reconciler.reconcile()).toEqual({ removedContainers: 0, removedBoxes: 0 });
    expect(boxes.removed).toEqual([]);
  });

  it('a helper the helper session already removed is not reported as a failure', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    boxes.list = [
      {
        id: 'helper-box',
        name: `${boxliteNamePrefix()}auth-helper`,
        state: { status: 'stopped', running: false },
      },
    ];
    boxes.removed = [];
    boxes.removeError = new Error('box not found: helper-box');
    const reconciler = new RuntimeReconciler(db as never, docker([]).client as never);
    expect(await reconciler.reconcile()).toEqual({ removedContainers: 0, removedBoxes: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('a helper failing to be removed for another reason is still a warning', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    boxes.list = [
      {
        id: 'helper-box',
        name: `${boxliteNamePrefix()}auth-helper`,
        state: { status: 'failed', running: false },
      },
    ];
    boxes.removeError = new Error('database is locked');
    const reconciler = new RuntimeReconciler(db as never, docker([]).client as never);
    await reconciler.reconcile();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('database is locked'));
  });
});

describe('a helper left under a provider that is no longer the default is removed whatever its state', () => {
  const registry = (defaultProvider: string) => ({ defaultProvider }) as never;
  const runningHelperBox = () => [
    {
      id: 'helper-box',
      name: `${boxliteNamePrefix()}auth-helper`,
      state: { status: 'running', running: true },
    },
  ];
  const runningHelperContainer = () =>
    docker([
      {
        Id: 'helper-container',
        Names: ['/platform-aio-auth-helper'],
        Labels: {
          'platform.sandboxId': 'auth-helper',
          'platform.provider': 'aio',
          [INSTANCE_LABEL]: platformInstanceId(),
        },
        State: 'running',
      },
    ]);

  it('switching from boxlite to aio retires the running BoxLite helper', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    boxes.list = runningHelperBox();
    boxes.removed = [];
    const d = runningHelperContainer();
    const reconciler = new RuntimeReconciler(db as never, d.client as never, registry('aio'));
    expect(await reconciler.reconcile()).toEqual({ removedContainers: 0, removedBoxes: 1 });
    expect(boxes.removed).toEqual(['helper-box']);
    expect(d.removed).toEqual([]);
  });

  it('switching from aio to boxlite retires the running aio helper container', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    boxes.list = runningHelperBox();
    boxes.removed = [];
    const d = runningHelperContainer();
    const reconciler = new RuntimeReconciler(db as never, d.client as never, registry('boxlite'));
    expect(await reconciler.reconcile()).toEqual({ removedContainers: 1, removedBoxes: 0 });
    expect(d.removed).toEqual(['helper-container']);
    expect(boxes.removed).toEqual([]);
  });
});
