import { describe, it, expect } from 'vitest';
import { RuntimeSettings } from '../../src/domain/entities/runtime-settings.entity';

/**
 * `PUT /api/runtimes/:rt/auth-mode` 的领域事件（23 §7.5 / 24 §214）。
 *
 * ⚠️ **文档一直写着 `RuntimeAuthModeChanged`（✅ Outbox），实现里此前没有。** 这一行
 * 决定**此后每一个沙箱**注入哪份凭证（05 §4.1），是典型的「改完之后系统行为变了、
 * 但没人知道是谁改的」——事后只有 `runtime_settings.updated_at` 一个时刻，
 * 连从哪一档换到哪一档都答不出来。
 */
const NOW = new Date('2026-08-28T00:00:00.000Z');
const LATER = new Date('2026-08-28T01:00:00.000Z');

describe('RuntimeSettings 的 auth-mode 事件', () => {
  it('切换发一条，带 from → to 两档', () => {
    const s = RuntimeSettings.rehydrate({
      runtimeId: 'claude-code',
      activeAuthMethod: 'account',
      updatedAt: NOW,
    });
    s.switchTo('api-key', LATER);
    const events = s.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'RuntimeAuthModeChanged',
      runtimeId: 'claude-code',
      from: 'account',
      to: 'api-key',
      occurredAt: LATER,
    });
  });

  it('切到已经生效的那一档不发事件', () => {
    // 那一次 PUT 什么都没改变；落一条 `account → account` 只会让「这一天到底换过
    // 几次」更难数。
    const s = RuntimeSettings.rehydrate({
      runtimeId: 'codex',
      activeAuthMethod: 'account',
      updatedAt: NOW,
    });
    s.switchTo('account', LATER);
    expect(s.pullEvents()).toEqual([]);
    // 但时间戳照旧推进 —— 不发事件不等于这次请求没被处理。
    expect(s.updatedAt).toEqual(LATER);
  });

  it('首配走 configureFirst，from 是 null（没有来处可写）', () => {
    const s = RuntimeSettings.configureFirst('codex', 'api-key', NOW);
    const [e] = s.pullEvents();
    expect(e).toMatchObject({ runtimeId: 'codex', from: null, to: 'api-key' });
  });

  it('⚠️ 裸 create 不发事件 —— credential 上下文顺手建行那条路径不会静默吞掉事件', () => {
    // `RuntimeSettingsReaderWriter.saveSync` 跑在**别人的事务**里、从不 pullEvents()。
    // 让 `create` 无条件 raise，等于让那条路径吞掉一个事件，而被吞掉的事件比压根
    // 没有的事件更难查。
    expect(RuntimeSettings.create('codex', 'api-key', NOW).pullEvents()).toEqual([]);
  });

  it('pullEvents 是**排空**，同一批不会被投递两次', () => {
    const s = RuntimeSettings.configureFirst('codex', 'account', NOW);
    expect(s.pullEvents()).toHaveLength(1);
    expect(s.pullEvents()).toEqual([]);
  });
});
