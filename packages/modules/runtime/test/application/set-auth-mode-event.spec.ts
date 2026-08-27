import { describe, it, expect } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { UnitOfWorkBase } from '@platform/shared-kernel';
import type { Clock, DomainEvent, EventBus, Tx } from '@platform/shared-kernel';
import type { RuntimeAdapter, RuntimeAdapterRegistry } from '@platform/contracts';
import { RuntimeApplicationService } from '../../src/application/runtime-application.service';
import { RuntimeSettings } from '../../src/domain/entities/runtime-settings.entity';
import type { RuntimeSettingsRepository } from '../../src/domain/repositories/runtime-settings.repository';

/**
 * `PUT /api/runtimes/:rt/auth-mode` 的**接线**（23 §12 / 24 §214）。
 *
 * ⚠️ 领域侧发不发事件由 `test/domain/runtime-settings-events.spec.ts` 钉住；这里钉的是
 * 另一半 —— **应用层有没有真的把它 publish 出去**。两件事分开测是刻意的：聚合 raise 了、
 * 应用层不 pull，是本仓已经存在的一种失败形状（`RuntimeSettingsReaderWriter.saveSync`
 * 那条路径就把事件丢在实体里），而它在领域测试里一条都不会红。
 */
const NOW = new Date('2026-08-28T00:00:00.000Z');
const clock: Clock = { now: () => NOW };

const adapter = { id: 'claude-code' } as RuntimeAdapter;
const registry: RuntimeAdapterRegistry = {
  register: () => undefined,
  get: (id) => {
    if (id !== 'claude-code') throw new Error(`unknown runtime '${id}'`);
    return adapter;
  },
  has: (id) => id === 'claude-code',
  list: () => [adapter],
};

/**
 * 真的 `UnitOfWorkBase` 子类，不是替身对象 —— `Tx` 是模块私有 symbol 品牌的，
 * 「拿得到 Tx」按构造就等于「正在一个同步事务里」（P2-1），伪造不出来。
 */
class DirectUnitOfWork extends UnitOfWorkBase {
  protected runInTransaction<T>(work: () => T): T {
    return work();
  }
}
const uow = new DirectUnitOfWork();

interface Harness {
  svc: RuntimeApplicationService;
  published: DomainEvent[];
  saved: RuntimeSettings[];
}

function harness(existing: RuntimeSettings | null, credentialStatus = 'valid'): Harness {
  const published: DomainEvent[] = [];
  const saved: RuntimeSettings[] = [];
  const events: EventBus = {
    publishInTx: (_tx: Tx, batch: DomainEvent[]) => published.push(...batch),
    subscribe: () => undefined,
  };
  const settings: RuntimeSettingsRepository = {
    findByRuntime: () => Promise.resolve(existing),
    saveSync: (_tx: Tx, s: RuntimeSettings) => void saved.push(s),
  };
  const credentials = { view: () => Promise.resolve({ credentialStatus }) };
  const svc = new RuntimeApplicationService(
    registry,
    undefined as never, // helper — unused by setAuthMode
    settings,
    undefined as never, // sessions
    credentials as never,
    uow,
    events,
    clock,
    undefined as never, // ids
  );
  return { svc, published, saved };
}

describe('setAuthMode 把 RuntimeAuthModeChanged 真的投递出去', () => {
  it('切换：一条事件，带 from → to，且与写行在同一个 uow.run 里', async () => {
    const existing = RuntimeSettings.rehydrate({
      runtimeId: 'claude-code',
      activeAuthMethod: 'account',
      updatedAt: NOW,
    });
    const { svc, published, saved } = harness(existing);

    const dto = await svc.setAuthMode('claude-code', 'api-key');

    expect(dto).toEqual({ runtimeId: 'claude-code', activeAuthMethod: 'api-key' });
    expect(saved).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: 'RuntimeAuthModeChanged',
      runtimeId: 'claude-code',
      from: 'account',
      to: 'api-key',
    });
  });

  it('首配（库里没有这一行）也投递，from 是 null —— 24 §214「首配时一并产生」', async () => {
    const { svc, published } = harness(null);
    await svc.setAuthMode('claude-code', 'api-key');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ from: null, to: 'api-key' });
  });

  it('切到已经生效的那一档：行照写，但不投递事件', async () => {
    const existing = RuntimeSettings.rehydrate({
      runtimeId: 'claude-code',
      activeAuthMethod: 'api-key',
      updatedAt: NOW,
    });
    const { svc, published, saved } = harness(existing);
    await svc.setAuthMode('claude-code', 'api-key');
    expect(saved).toHaveLength(1);
    expect(published).toEqual([]);
  });

  it('目标档没有凭证 ⇒ 409，且**什么都不投递**（I-RTS-2）', async () => {
    const { svc, published } = harness(null, 'none');
    await expect(svc.setAuthMode('claude-code', 'api-key')).rejects.toBeInstanceOf(
      ConflictException,
    );
    // 失败路径不发领域事件（13 §2.8.2）—— 这一档的失败由 409 信封回答。
    expect(published).toEqual([]);
  });
});
