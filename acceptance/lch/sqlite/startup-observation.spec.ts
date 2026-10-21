import { describe, expect, it } from 'vitest';
import { StartupObservationSchema } from '@platform/contracts';
import type { SandboxStartupProgress } from '../../../packages/modules/sandbox/src/domain/ports/sandbox-startup-progress.port';
import { SqliteSandboxStartupProgress } from '../../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/sandbox-startup-progress.impl';
import { currentDatabase } from '../../support/sqlite';
import { harness } from '../../support/sandbox-rig';

describe('durable original startup facts [AC-LCH-012.2] [AC-LCH-013.3]', () => {
  it('keeps progress clocks across readers and rejects stale/duplicate facts and retired cycles', () => {
    const { sqlite, db, uow } = currentDatabase();
    try {
      const store = new SqliteSandboxStartupProgress(db);
      const at = new Date('2026-10-18T02:00:00Z');
      const original: SandboxStartupProgress = {
        operationId: 'sandbox-startup:original:4',
        sequence: 3,
        state: 'unknown',
        stage: 'instance-start',
        startedAt: '2026-10-18T01:50:00.000Z',
        stageEnteredAt: '2026-10-18T01:51:00.000Z',
        lastProgressAt: '2026-10-18T01:51:00.000Z',
        heartbeatAt: null,
      };
      uow.run((tx) => store.saveSync(tx, 'original', original, at));
      const heartbeat = { ...original, sequence: 4, heartbeatAt: at.toISOString() };
      uow.run((tx) => store.saveSync(tx, 'original', heartbeat, at));
      const freshReader = new SqliteSandboxStartupProgress(db);
      expect(freshReader.readSync('original')).toEqual(heartbeat);
      expect(
        StartupObservationSchema.parse({
          ...freshReader.readSync('original'),
          observedAt: new Date(at.getTime() + 60000).toISOString(),
        }).lastProgressAt,
      ).toBe(original.lastProgressAt);
      // A late status/duplicate event cannot replace a more recent heartbeat or
      // claim progress merely by carrying the same sequence and another payload.
      uow.run((tx) => store.saveSync(tx, 'original', original, at));
      uow.run((tx) => store.saveSync(tx, 'original', { ...heartbeat, stage: 'completed' }, at));
      expect(freshReader.readSync('original')).toEqual(heartbeat);
      const nextCycle: SandboxStartupProgress = {
        ...original,
        operationId: 'sandbox-startup:original:8',
        sequence: 0,
        state: 'inflight',
        startedAt: at.toISOString(),
        stageEnteredAt: at.toISOString(),
        lastProgressAt: at.toISOString(),
      };
      uow.run((tx) => store.saveSync(tx, 'original', nextCycle, at));
      uow.run((tx) => store.saveSync(tx, 'original', { ...heartbeat, sequence: 999 }, at));
      expect(freshReader.readSync('original')).toEqual(nextCycle);
      expect(freshReader.readSync('missing')).toBeUndefined();
      expect(sqlite.prepare('SELECT count(*) n FROM platform_operations').get()).toEqual({
        n: 1,
      });
      expect(sqlite.prepare('SELECT count(*) n FROM sandbox_create_intents').get()).toEqual({
        n: 0,
      });
    } finally {
      sqlite.close();
    }
  });
  it('starts a new observation cycle only for a fresh explicit restart, retaining the original Guest', async () => {
    const h = harness();
    h.sqlite
      .prepare(
        "INSERT INTO projects(id,name,source_type,clone_status,baseline_path,created_at,updated_at) VALUES('prj','fixture','empty','ready','/tmp/fixture-baseline',0,0)",
      )
      .run();
    const created = await h.service.create({ projectId: 'prj', runtime: 'claude-code' });
    await expect.poll(async () => (await h.service.get(created.id)).status).toBe('running');
    const first = (await h.service.get(created.id)).startupObservation;
    const original = h.sqlite
      .prepare('SELECT provider_handle FROM sandboxes WHERE id=?')
      .get(created.id);
    await h.service.stop(created.id);
    h.advanceClock(1000);
    await h.service.start(created.id);
    await expect.poll(async () => (await h.service.get(created.id)).status).toBe('running');
    const next = (await h.service.get(created.id)).startupObservation;
    expect(next?.operationId).not.toBe(first?.operationId);
    expect(next?.startedAt).toBe(h.clock.now().toISOString());
    expect(next?.state).toBe('succeeded');
    expect(
      h.sqlite.prepare('SELECT provider_handle FROM sandboxes WHERE id=?').get(created.id),
    ).toEqual(original);
    expect(h.provider.calls.filter((v) => v === 'create')).toHaveLength(1);
  });
});
