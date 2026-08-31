import { Readable } from 'node:stream';
import { beforeEach, describe, it, expect } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { UnitOfWorkBase } from '@platform/shared-kernel';
import type { Clock, EventBus, IdGenerator, Tx, DomainEvent } from '@platform/shared-kernel';
import type { AuditRecordInput } from '@platform/contracts';
import { RetainedVolumeService } from '../../src/application/retained-volume.service';
import { VolumeReaper } from '../../src/application/volume.reaper';
import { RetainedVolume } from '../../src/domain/entities/retained-volume.entity';
import type { RetainedVolumeRepository } from '../../src/domain/repositories/retained-volume.repository';
import type {
  RetainedVolumeArchive,
  RetainedVolumeMeasurement,
  RetainedVolumeStore,
} from '../../src/domain/ports/retained-volume-store.port';

/**
 * `RetainedVolumeService` —— 03 §7.7 / 24 §5 那条链路的编排纪律。
 *
 * ── 每组断言钉住的变异 ──────────────────────────────────────────────────────────
 *  ① `register` 里 `findByWorkspacePath` 那道早退删掉 ⇒「重放不重复登记」红
 *     （24 §5.2：T1/T2 之间崩溃后重放会再走一次这里）。
 *  ② `register` 里 `store.exists` 那道早退删掉 ⇒「目录不在就不登记」红。
 *  ③ `remove` 把「先删目录、后置 deletedAt」的顺序调过来 ⇒「顺序」那条红。
 *  ④ `remove`/`openArchive` 里 `|| volume.isDeleted` 去掉 ⇒ I-RV-2 两条红。
 *  ⑤ `openArchive` 改成读库里的 `downloadBytes` 而不是重算 ⇒「大小在下载这一刻重算」红。
 *  ⑥ `reapExpired` 的 try/catch 去掉 ⇒「一条清不掉不带走整批」红。
 *  ⑦ `VolumeReaper` 的 `running` 锁去掉 ⇒「不重入」红。
 */
class TestUow extends UnitOfWorkBase {
  protected runInTransaction<T>(work: () => T): T {
    return work();
  }
}

function makeHarness(opts: { removeFails?: string } = {}) {
  const now = new Date('2026-08-31T00:00:00.000Z');
  const clock: Clock = { now: () => new Date(now.getTime()) };
  let seq = 0;
  const ids: IdGenerator = { next: () => `rv-${String(++seq)}` };
  const published: DomainEvent[] = [];
  const events: EventBus = {
    publishInTx: (_tx: Tx, batch: DomainEvent[]) => void published.push(...batch),
    subscribe: () => undefined,
  };
  const audits: AuditRecordInput[] = [];
  const rows = new Map<string, RetainedVolume>();
  const saved: string[] = [];
  /**
   * ⚠️ **一条共享的时间线，不是两个各自的数组。** `remove` 的纪律是「先删目录、再置
   * deletedAt」——两个数组各记各的，把顺序调过来两边内容都不变，变异照样绿（实测：
   * 这个变异第一版真的活下来了）。顺序断言只有共享同一条日志才成立。
   */
  const timeline: string[] = [];
  const repo: RetainedVolumeRepository = {
    async findById(id) {
      return rows.get(id) ?? null;
    },
    async findByWorkspacePath(p) {
      return [...rows.values()].find((v) => v.workspacePath === p) ?? null;
    },
    async listByProject(projectId, includeDeleted = false) {
      return [...rows.values()].filter(
        (v) => v.projectId === projectId && (includeDeleted || !v.isDeleted),
      );
    },
    async listAll(includeDeleted = false) {
      return [...rows.values()].filter((v) => includeDeleted || !v.isDeleted);
    },
    async listExpired(at) {
      return [...rows.values()].filter((v) => v.isExpiredAt(at));
    },
    saveSync(_tx, volume) {
      saved.push(`${volume.id}:${volume.isDeleted ? 'deleted' : 'live'}`);
      timeline.push(`save:${volume.id}:${volume.isDeleted ? 'deleted' : 'live'}`);
      rows.set(volume.id, volume);
    },
  };

  const calls: string[] = [];
  const present = new Set<string>();
  let measurement: RetainedVolumeMeasurement = {
    diskBytes: 1_073_741_824,
    downloadBytes: 14_680_064,
  };
  let archiveSize = 14_680_064;
  const store: RetainedVolumeStore = {
    async exists(p) {
      return present.has(p);
    },
    async measure() {
      calls.push('measure');
      return measurement;
    },
    async openArchive(): Promise<RetainedVolumeArchive> {
      calls.push('openArchive');
      return { stream: Readable.from([Buffer.alloc(0)]), sizeBytes: archiveSize };
    },
    async remove(p) {
      calls.push(`remove:${p}`);
      timeline.push(`remove:${p}`);
      if (opts.removeFails === p) throw new Error('EBUSY');
      present.delete(p);
    },
  };

  const service = new RetainedVolumeService(repo, store, new TestUow(), events, clock, ids, {
    record: (input) => audits.push(input),
  });
  return {
    service,
    reaper: new VolumeReaper(service),
    rows,
    saved,
    timeline,
    calls,
    present,
    audits,
    published,
    clock,
    now,
    setMeasurement: (m: RetainedVolumeMeasurement) => (measurement = m),
    setArchiveSize: (n: number) => (archiveSize = n),
  };
}

const WS = '/data/workspaces/sbx-1';

describe('RetainedVolumeService（03 §7.7 / 24 §5）', () => {
  let h: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    h = makeHarness();
    h.present.add(WS);
  });

  describe('register —— RegisterRetainedVolumeCommand', () => {
    it('登记一条记录，两个大小都量、都存，并发出 VolumeRetained', async () => {
      await h.service.register({
        projectId: 'prj-1',
        sandboxId: 'sbx-1',
        workspacePath: WS,
        source: 'manual-destroy',
      });
      const [volume] = [...h.rows.values()];
      expect(volume.workspacePath).toBe(WS);
      expect(volume.diskBytes).toBe(1_073_741_824);
      expect(volume.downloadBytes).toBe(14_680_064);
      // 默认 30 天（P20 §6）
      expect(volume.retainUntil.toISOString()).toBe('2026-09-30T00:00:00.000Z');
      expect(h.published.map((e) => e.type)).toEqual(['VolumeRetained']);
    });

    it('自动化产物走规则的保留期（3/7/30），不是恒 30 天', async () => {
      await h.service.register({
        projectId: 'prj-1',
        workspacePath: WS,
        source: 'automation-artifact',
        retentionDays: 3,
      });
      const [volume] = [...h.rows.values()];
      expect(volume.source).toBe('automation-artifact');
      expect(volume.retainUntil.toISOString()).toBe('2026-09-03T00:00:00.000Z');
    });

    it('★ 幂等：同一个 workspacePath 再登记一次是 no-op（24 §5.2 的重放路径）', async () => {
      const cmd = {
        projectId: 'prj-1',
        sandboxId: 'sbx-1',
        workspacePath: WS,
        source: 'manual-destroy',
      } as const;
      await h.service.register(cmd);
      await h.service.register(cmd);
      expect(h.rows.size).toBe(1);
      expect(h.published).toHaveLength(1);
      // 第二次连量都不该量 —— 那是一次对 1.0 GB 目录的整棵树遍历
      expect(h.calls.filter((c) => c === 'measure')).toHaveLength(1);
    });

    it('★ 目录不在就不登记 —— 否则「已保留卷」会列出一个点开就 404 的条目', async () => {
      h.present.delete(WS);
      await h.service.register({ projectId: 'prj-1', workspacePath: WS, source: 'manual-destroy' });
      expect(h.rows.size).toBe(0);
      expect(h.published).toHaveLength(0);
    });
  });

  describe('list', () => {
    it('按项目过滤；不带 projectId 就是全部项目', async () => {
      h.present.add('/data/workspaces/sbx-2');
      await h.service.register({ projectId: 'prj-1', workspacePath: WS, source: 'manual-destroy' });
      await h.service.register({
        projectId: 'prj-2',
        workspacePath: '/data/workspaces/sbx-2',
        source: 'manual-destroy',
      });
      expect((await h.service.list('prj-1')).map((d) => d.projectId)).toEqual(['prj-1']);
      expect(await h.service.list()).toHaveLength(2);
    });

    it('⛔ DTO 不含 workspacePath（宿主绝对路径 = 部署布局，10 §7.3）', async () => {
      await h.service.register({ projectId: 'prj-1', workspacePath: WS, source: 'manual-destroy' });
      const [dto] = await h.service.list('prj-1');
      expect(JSON.stringify(dto)).not.toContain('/data/workspaces');
      expect(dto.diskBytes).toBe(1_073_741_824);
      expect(dto.downloadBytes).toBe(14_680_064);
    });
  });

  describe('remove', () => {
    beforeEach(async () => {
      await h.service.register({
        projectId: 'prj-1',
        sandboxId: 'sbx-1',
        workspacePath: WS,
        source: 'manual-destroy',
      });
      h.calls.length = 0;
      h.saved.length = 0;
      h.timeline.length = 0;
    });

    it('★ 先删目录、再置 deletedAt —— 反过来崩溃就留下一个谁也管不到的目录', async () => {
      await h.service.remove('rv-1');
      // ★ 一条共享时间线：顺序本身就是断言的内容（见 harness 里 `timeline` 的注释）
      expect(h.timeline).toEqual([`remove:${WS}`, 'save:rv-1:deleted']);
      expect(h.calls).toEqual([`remove:${WS}`]);
      expect(h.saved).toEqual(['rv-1:deleted']);
      expect(h.rows.get('rv-1')?.deletedAt?.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    });

    it('★ I-RV-2：已清理的记录对外等于不存在（404，不是 200 也不是 500）', async () => {
      await h.service.remove('rv-1');
      await expect(h.service.remove('rv-1')).rejects.toBeInstanceOf(NotFoundException);
      await expect(h.service.remove('rv-nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('清理记一条审计（回收了多少磁盘，用的是 diskBytes 不是 downloadBytes）', async () => {
      await h.service.remove('rv-1');
      const audit = h.audits.at(-1);
      expect(audit?.type).toBe('project.volume_deleted');
      expect(audit?.actor).toBe('user');
      expect(audit?.detail?.diskBytes).toBe(1_073_741_824);
    });
  });

  describe('openArchive', () => {
    beforeEach(async () => {
      await h.service.register({
        projectId: 'prj-1',
        sandboxId: 'sbx-1',
        workspacePath: WS,
        source: 'manual-destroy',
      });
    });

    it('★ 大小在下载这一刻重算，不读库里那个登记时的数', async () => {
      h.setArchiveSize(999);
      const archive = await h.service.openArchive('rv-1');
      expect(archive.sizeBytes).toBe(999); // 库里存的是 14_680_064
      expect(archive.filename).toBe('sbx-1.tar');
    });

    it('★ I-RV-2：已清理的不可下载（能给的只有一个空 tar，那是撒谎）', async () => {
      await h.service.remove('rv-1');
      await expect(h.service.openArchive('rv-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('记录还在但目录已经没了 ⇒ 404，不是一个 20 字节的空包', async () => {
      h.present.delete(WS);
      await expect(h.service.openArchive('rv-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('reapExpired / VolumeReaper', () => {
    it('到期的删掉并置 deletedAt，没到期的一个不碰', async () => {
      h.present.add('/data/workspaces/sbx-2');
      await h.service.register({
        projectId: 'prj-1',
        workspacePath: WS,
        source: 'automation-artifact',
        retentionDays: 3,
      });
      await h.service.register({
        projectId: 'prj-1',
        workspacePath: '/data/workspaces/sbx-2',
        source: 'manual-destroy',
      });
      // 时钟推到 3 天期满之后、30 天之前
      (h.clock as { now: () => Date }).now = () => new Date('2026-09-05T00:00:00.000Z');

      expect(await h.service.reapExpired()).toBe(1);
      expect(h.rows.get('rv-1')?.isDeleted).toBe(true);
      expect(h.rows.get('rv-2')?.isDeleted).toBe(false);
      expect(h.audits.at(-1)?.actor).toBe('reaper');
    });

    it('★ 一条清不掉不带走整批 —— 下一轮还会扫到它（deletedAt 仍是 NULL）', async () => {
      const g = makeHarness({ removeFails: '/data/workspaces/stuck' });
      g.present.add('/data/workspaces/stuck');
      g.present.add('/data/workspaces/ok');
      await g.service.register({
        projectId: 'prj-1',
        workspacePath: '/data/workspaces/stuck',
        source: 'manual-destroy',
        retentionDays: 3,
      });
      await g.service.register({
        projectId: 'prj-1',
        workspacePath: '/data/workspaces/ok',
        source: 'manual-destroy',
        retentionDays: 3,
      });
      (g.clock as { now: () => Date }).now = () => new Date('2026-09-05T00:00:00.000Z');

      expect(await g.service.reapExpired()).toBe(1);
      expect(g.rows.get('rv-1')?.isDeleted).toBe(false); // 卡住的那条留给下一轮
      expect(g.rows.get('rv-2')?.isDeleted).toBe(true);
    });

    it('★ VolumeReaper 不重入：上一轮没跑完时下一轮直接返回', async () => {
      let release = (): void => undefined;
      const gate = new Promise<void>((r) => (release = r));
      let entered = 0;
      // 真类型的替身：走原型造一个 `RetainedVolumeService`，只换掉 reaper 会调的那一个
      // 方法 —— 比双重断言诚实（reaper 拿到的确实是它声明要的那个类型）。
      const slow: RetainedVolumeService = Object.create(
        RetainedVolumeService.prototype,
      ) as RetainedVolumeService;
      slow.reapExpired = async (): Promise<number> => {
        entered += 1;
        await gate;
        return 1;
      };
      const reaper = new VolumeReaper(slow);
      const first = reaper.runOnce();
      const second = await reaper.runOnce();
      expect(second).toBe(0);
      expect(entered).toBe(1);
      release();
      expect(await first).toBe(1);
    });
  });
});
