import { describe, it, expect } from 'vitest';
import { asProjectId, asRetainedVolumeId } from '@platform/shared-kernel';
import { RetainedVolume } from '../../src/domain/entities/retained-volume.entity';
import { VolumeRetained } from '../../src/domain/events/project-events';
import { RetainedVolumeStateError } from '../../src/domain/errors/project-errors';

/**
 * `RetainedVolume` 的三条不变量（23 §6.2）。
 *
 * ── 每条断言钉住的变异 ──────────────────────────────────────────────────────────
 *  ① 删掉 `ALLOWED_RETENTION_DAYS` 那道校验 ⇒「保留期只有 3/7/30」两条红。
 *  ② 把 `retainUntil` 算成 `now`（或减法写成加法之外的任何值）⇒「retainUntil 严格晚于
 *     retainedAt」+ 三个天数的到期时刻断言一起红。
 *  ③ 把 `assertMutable` 改成 no-op（I-RV-2 失效）⇒「清理过的记录只读」两条红。
 *  ④ 不 `raise(VolumeRetained)` ⇒「登记会产生领域事件」红 —— 没有它审计流里就没有
 *     「什么时候留下来的、留到什么时候」这一行。
 */
describe('RetainedVolume 聚合（23 §6.2 I-RV-1/2/3）', () => {
  const now = new Date('2026-08-31T00:00:00.000Z');

  const register = (overrides: Partial<Parameters<typeof RetainedVolume.register>[0]> = {}) =>
    RetainedVolume.register({
      id: asRetainedVolumeId('rv-1'),
      projectId: asProjectId('prj-1'),
      sandboxId: 'sbx-1',
      workspacePath: '/data/workspaces/sbx-1',
      source: 'manual-destroy',
      retentionDays: 30,
      diskBytes: 1_073_741_824,
      downloadBytes: 14_680_064,
      now,
      ...overrides,
    });

  type RegisterInput = Parameters<typeof RetainedVolume.register>[0];
  /** 只放宽 `retentionDays` 这一个字段 —— 不是双重断言，是把闭集放回 `number`。 */
  const registerWithDays = (days: number): RetainedVolume =>
    RetainedVolume.register({
      id: asRetainedVolumeId('rv-1'),
      projectId: asProjectId('prj-1'),
      workspacePath: '/data/workspaces/sbx-1',
      source: 'manual-destroy',
      retentionDays: days,
      diskBytes: 1,
      downloadBytes: 1,
      now,
    } as Omit<RegisterInput, 'retentionDays'> & { retentionDays: number } as RegisterInput);

  describe('I-RV-1 保留期', () => {
    it.each([3, 7, 30] as const)('%i 天是合法保留期，retainUntil 就是 now + N 天', (days) => {
      const volume = register({ retentionDays: days });
      expect(volume.retainUntil.toISOString()).toBe(
        new Date(now.getTime() + days * 86_400_000).toISOString(),
      );
    });

    it.each([14, 0, -30, 31])(
      '保留期只有 3/7/30 —— %i 天是调用方算错了，不是可以四舍五入的输入',
      (days) => {
        // 走一个**放宽了这一个字段**的入口，模拟绕过契约的调用方（自动化那条路传的是
        // 规则里的数字，类型上就是 `number`）。
        expect(() => registerWithDays(days)).toThrow(RetainedVolumeStateError);
      },
    );

    it('retainUntil 严格晚于 retainedAt', () => {
      const volume = register();
      expect(volume.retainUntil.getTime()).toBeGreaterThan(volume.retainedAt.getTime());
    });

    it('⚠️ 不改调用方传进来的那个 `now` —— shiftMs 是原地改的，直接传会把它一起挪走', () => {
      const caller = new Date('2026-08-31T00:00:00.000Z');
      register({ now: caller });
      expect(caller.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    });
  });

  describe('I-RV-2 deletedAt 非空 ⇒ 只读（留档审计）', () => {
    it('清理之前是可写的，清理之后任何写入都不合法', () => {
      const volume = register();
      expect(volume.isDeleted).toBe(false);
      volume.markDeleted(new Date('2026-09-30T00:00:00.000Z'));
      expect(volume.isDeleted).toBe(true);
      expect(volume.deletedAt?.toISOString()).toBe('2026-09-30T00:00:00.000Z');

      // 第二次「清理」说明调用方以为自己刚删掉了某个目录 —— 那个目录其实早没了
      expect(() => volume.markDeleted(new Date('2026-10-01T00:00:00.000Z'))).toThrow(
        RetainedVolumeStateError,
      );
      expect(() => volume.detachSandbox()).toThrow(RetainedVolumeStateError);
      // 而且不许把 deletedAt 覆盖成第二次的时刻
      expect(volume.deletedAt?.toISOString()).toBe('2026-09-30T00:00:00.000Z');
    });

    it('已清理的记录不再算「到期」—— 否则 reaper 每轮都会把它重新捞出来', () => {
      const volume = register({ retentionDays: 3 });
      const afterExpiry = new Date('2026-09-10T00:00:00.000Z');
      expect(volume.isExpiredAt(afterExpiry)).toBe(true);
      volume.markDeleted(afterExpiry);
      expect(volume.isExpiredAt(afterExpiry)).toBe(false);
    });

    it('保留期内不算到期', () => {
      const volume = register({ retentionDays: 30 });
      expect(volume.isExpiredAt(new Date('2026-09-01T00:00:00.000Z'))).toBe(false);
    });
  });

  it('I-RV-3 的应用层前提：workspacePath 是身份，空串直接拒', () => {
    expect(() => register({ workspacePath: '   ' })).toThrow(RetainedVolumeStateError);
  });

  it('登记会产生 VolumeRetained 领域事件（23 §6.4），且不带宿主路径', () => {
    const volume = register();
    const events = volume.pullEvents();
    expect(events).toHaveLength(1);
    const event = events[0] as VolumeRetained;
    expect(event).toBeInstanceOf(VolumeRetained);
    expect(event.volumeId).toBe('rv-1');
    expect(event.projectId).toBe('prj-1');
    expect(event.retainUntil.toISOString()).toBe('2026-09-30T00:00:00.000Z');
    expect(event.diskBytes).toBe(1_073_741_824);
    expect(event.downloadBytes).toBe(14_680_064);
    // ⛔ 宿主绝对路径对外等于泄露部署布局（10 §7.3 同一条纪律）
    expect(JSON.stringify(event)).not.toContain('/data/workspaces');
  });

  it('sandboxId 是弱引用：sandbox 记录归档后可以置空，卷仍可管理', () => {
    const volume = register();
    expect(volume.sandboxId).toBe('sbx-1');
    volume.detachSandbox();
    expect(volume.sandboxId).toBeNull();
  });
});
