import { describe, it, expect, vi } from 'vitest';
import { HelperContainerSession } from '@platform/runtime';
import type { HelperObservation } from '@platform/runtime';
import { AuthHelperCheck } from '../../../apps/api/src/platform/system/diagnostics/checks/auth-helper.check';

function observed(state: HelperObservation) {
  const session = Object.create(HelperContainerSession.prototype) as HelperContainerSession;
  const observeSpy = vi.spyOn(session, 'observe').mockResolvedValue(state);
  const requireSpy = vi
    .spyOn(session, 'require')
    .mockRejectedValue(new Error('诊断不得创建 helper'));
  const invalidateSpy = vi.spyOn(session, 'invalidate').mockImplementation(() => {
    throw new Error('诊断不得作废 helper');
  });
  return { session, observeSpy, requireSpy, invalidateSpy };
}

describe('帐号登录环境只读诊断', () => {
  it.each([
    [
      {
        ready: true,
        starting: false,
        lastError: null,
        instanceState: 'instance_running',
        stale: false,
      },
      'ok',
      '帐号登录可用',
    ],
    [{ ready: false, starting: true, lastError: null }, 'info', '登录环境准备中'],
    [{ ready: false, starting: false, lastError: 'CLI 版本不受支持' }, 'warn', '帐号登录暂不可用'],
    [
      {
        ready: true,
        starting: false,
        lastError: null,
        instanceState: 'instance_exited',
        stale: true,
      },
      'warn',
      '帐号登录环境已失效',
    ],
    [
      { ready: true, starting: false, lastError: null, probeError: '5 秒内没有答复' },
      'info',
      '登录环境状态待确认',
    ],
    [
      {
        ready: false,
        starting: false,
        lastError: '上一个实例 vm-1 已失效：存活复核：实例已不在运行（instance_dead）',
        awaitingRebuild: true,
      },
      'warn',
      '帐号登录环境已失效',
    ],
  ] as const)('状态 %j 如实返回且不创建、不作废 helper', async (state, status, headline) => {
    const { session, observeSpy, requireSpy, invalidateSpy } = observed(state);
    const result = await new AuthHelperCheck(session).run();
    expect(result.status).toBe(status);
    expect(result.headline).toBe(headline);
    expect(observeSpy).toHaveBeenCalledOnce();
    expect(requireSpy).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
    if (status !== 'ok') expect(result.detailText).toContain('API Key 不受影响');
    if (state.lastError !== null) expect(result.detailText).toContain(state.lastError);
  });

  it('可用时说明常驻占用已从调度容量里预留', async () => {
    const { session } = observed({
      ready: true,
      starting: false,
      lastError: null,
      instanceState: 'instance_running',
      stale: false,
    });
    const result = await new AuthHelperCheck(session).run();
    expect(result.detailText).toContain('1 核 CPU、512 MB 内存');
    expect(result.detailText).toContain('已从任务调度容量中预留');
  });

  it('已作废、等待重建时说明会自动重建、怎么立刻重建，⛔ 不把人引去查镜像', async () => {
    const { session } = observed({
      ready: false,
      starting: false,
      lastError: '上一个实例 vm-1 已失效：建隔离 HOME时 provider 报 INTERNAL：transport error',
      awaitingRebuild: true,
    });
    const result = await new AuthHelperCheck(session).run();
    expect(result.nextStep).toContain('自动重建');
    expect(result.nextStep).toContain('发起一次「帐号登录」再取消');
    expect(result.nextStep).not.toContain('镜像');
    expect(result).not.toHaveProperty('errorCode');
  });

  it('实例已退出时报失效、写出实例状态，并说明下次使用会自动重建', async () => {
    const { session } = observed({
      ready: true,
      starting: false,
      lastError: null,
      instanceState: 'instance_exited',
      stale: true,
    });
    const result = await new AuthHelperCheck(session).run();
    expect(result).toMatchObject({
      status: 'warn',
      headline: '帐号登录环境已失效',
      detail: { instanceState: 'instance_exited' },
    });
    expect(result.detailText).toContain('已停止运行');
    expect(result.nextStep).toContain('自动重建');
  });
});
