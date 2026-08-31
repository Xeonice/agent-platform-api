import { describe, it, expect } from 'vitest';
import { readBoxliteHealth } from '../../src/infrastructure/providers/boxlite/boxlite-health';
import { readAioHealth } from '../../src/infrastructure/providers/aio/aio-health';

const AT = '2026-08-31T00:00:00.000Z';

/**
 * 两个 provider 的**零成本层**健康映射（03 §7.8）。
 *
 * ── 每组断言钉住的变异 ──────────────────────────────────────────────────────────
 *  ① boxlite 的 `None` 映射成 `healthy`（而不是 `unknown`）⇒「没配 health check ≠ 健康」红。
 *  ② `running === false` 那道早退删掉 ⇒「VM 不在跑就是 unhealthy」红。
 *  ③ aio 改成拿 `State.Health` 当判据 ⇒「8080 才是判据」那两条红 —— 那正是实测里
 *     「60s 后 docker 说 unhealthy，而沙箱完全可用」的场景。
 *  ④ aio 把 `agentReachable === undefined` 读成 `unhealthy` ⇒「没问出来 ≠ 不健康」红。
 */
describe('boxlite 零成本健康信号', () => {
  const base = { running: true, at: AT };

  it.each([
    ['Healthy', 'healthy'],
    ['Unhealthy', 'unhealthy'],
    ['Starting', 'starting'],
  ] as const)('healthStatus=%s ⇒ %s', (from, want) => {
    expect(readBoxliteHealth({ ...base, state: { state: from, failures: 0 } }).health.state).toBe(
      want,
    );
  });

  it('★ `None`（镜像没配 health check）⇒ unknown，**不是** healthy', () => {
    // 「没问出来」与「问了，答健康」是两件事。读成 healthy 就是替 provider 编一个
    // 它没说过的答案（同 04 §11「不知道不是 false」）。
    expect(readBoxliteHealth({ ...base, state: { state: 'None', failures: 0 } }).health.state).toBe(
      'unknown',
    );
  });

  it('★ VM 不在跑 ⇒ unhealthy，且 consecutiveFailures 至少为 1', () => {
    const reading = readBoxliteHealth({
      running: false,
      at: AT,
      state: { state: 'Healthy', failures: 0 }, // BoxLite 自己的计数器还是 0
    });
    expect(reading.health.state).toBe('unhealthy');
    expect(reading.health.consecutiveFailures).toBe(1);
  });

  it('BoxLite 自己的 failures 原样带出（那是它的计数器，不是平台的抗抖动计数）', () => {
    expect(
      readBoxliteHealth({ ...base, state: { state: 'Unhealthy', failures: 4 } }).health
        .consecutiveFailures,
    ).toBe(4);
  });

  it('lastCheck 有就用它；没有才用采样时刻', () => {
    expect(
      readBoxliteHealth({
        ...base,
        state: { state: 'Healthy', failures: 0, lastCheck: '2026-01-01T00:00:00.000Z' },
      }).health.lastCheckedAt,
    ).toBe('2026-01-01T00:00:00.000Z');
    expect(
      readBoxliteHealth({ ...base, state: { state: 'Healthy', failures: 0 } }).health.lastCheckedAt,
    ).toBe(AT);
  });

  it('execErrorsTotal 原样带出（差分由 monitor 做，这一层不判）', () => {
    const reading = readBoxliteHealth({
      ...base,
      state: { state: 'Healthy', failures: 0 },
      execErrorsTotal: 7,
    });
    // ⚠️ 累计 7 次错**不代表**现在不健康 —— 就地判「>0 即不健康」会把一个开机以来
    // 出过一次错的健康沙箱判死。
    expect(reading.health.state).toBe('healthy');
    expect(reading.execErrorsTotal).toBe(7);
  });
});

describe('aio 零成本健康信号（判据是 8080，不是镜像自带的 HEALTHCHECK）', () => {
  it('★ docker 说 unhealthy、8080 却答 200 ⇒ healthy（实测里的默认路径）', () => {
    // 镜像 HEALTHCHECK 探 8091+9222，浏览器口默认不起 ⇒ 60s 后必报 unhealthy，
    // 而平台用的 8080 完全可用。语义是单向的：healthy ⇒ 可用，unhealthy ⇏ 不可用。
    const health = readAioHealth({
      agentReachable: true,
      dockerHealth: 'unhealthy',
      dockerFailingStreak: 10,
      running: true,
      at: AT,
    });
    expect(health.state).toBe('healthy');
    expect(health.consecutiveFailures).toBe(0);
    // 辅助信号仍然要出现在诊断详情里 —— 排障的人需要看到它
    expect(health.message).toContain('State.Health=unhealthy');
  });

  it('★ docker 说 healthy、8080 却打不通 ⇒ unhealthy（判据只有一个）', () => {
    const health = readAioHealth({
      agentReachable: false,
      dockerHealth: 'healthy',
      running: true,
      at: AT,
    });
    expect(health.state).toBe('unhealthy');
    expect(health.consecutiveFailures).toBe(1);
  });

  it('★ 没问出来 ⇒ unknown，不是 unhealthy（一次网络抖动不该看起来像沙箱挂了）', () => {
    const health = readAioHealth({ agentReachable: undefined, running: true, at: AT });
    expect(health.state).toBe('unknown');
    expect(health.consecutiveFailures).toBe(0);
  });

  it('容器不在跑 ⇒ unhealthy，连问都不用问', () => {
    expect(readAioHealth({ agentReachable: true, running: false, at: AT }).state).toBe('unhealthy');
  });
});
