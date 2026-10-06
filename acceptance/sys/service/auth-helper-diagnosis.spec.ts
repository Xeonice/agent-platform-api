import { describe, it, expect, vi } from 'vitest';
import { HelperContainerSession } from '@platform/runtime';
import { AuthHelperCheck } from '../../../apps/api/src/platform/system/diagnostics/checks/auth-helper.check';

describe('帐号登录环境只读三态', () => {
  it.each([
    [{ ready: true, starting: false, lastError: null }, 'ok', '帐号登录可用'],
    [{ ready: false, starting: true, lastError: null }, 'info', '登录环境准备中'],
    [{ ready: false, starting: false, lastError: 'CLI 版本不受支持' }, 'warn', '帐号登录暂不可用'],
  ] as const)('状态 %j 如实返回且不创建 helper', async (state, status, headline) => {
    const session = Object.create(HelperContainerSession.prototype) as HelperContainerSession;
    const statusSpy = vi.spyOn(session, 'status').mockReturnValue(state);
    const requireSpy = vi
      .spyOn(session, 'require')
      .mockRejectedValue(new Error('诊断不得创建 helper'));
    const result = await new AuthHelperCheck(session).run();
    expect(result.status).toBe(status);
    expect(result.headline).toBe(headline);
    expect(statusSpy).toHaveBeenCalledOnce();
    expect(requireSpy).not.toHaveBeenCalled();
    if (status !== 'ok') expect(result.detailText).toContain('API Key 不受影响');
    if (state.lastError !== null) expect(result.detailText).toContain(state.lastError);
  });
});
