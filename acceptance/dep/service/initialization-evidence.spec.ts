import { describe, expect, it, vi } from 'vitest';
import { type ConnectivityResult, ProxyConfigSchema } from '@platform/contracts';
import { InitializationService } from '../../../apps/api/src/platform/system/initialization.service';

function harness(rows: ConnectivityResult[]) {
  const mark = vi.fn();
  const settings = {
    initialized: () => false,
    markInitialized: mark,
    initStatus: () => ({ initialized: true }),
  };
  const service = new InitializationService(
    settings as never,
    { run: async () => rows } as never,
    { record: vi.fn() } as never,
  );
  return { service, mark };
}
const timeout: ConnectivityResult = {
  target: 'api.model.test',
  ok: false,
  modelApi: true,
  timedOut: true,
};

describe('DEP timeout不能驱动离线确认', () => {
  it('模型API全超时或失败与超时混合，允许继续并保存实际结果', async () => {
    for (const rows of [
      [timeout],
      [timeout, { ...timeout, target: 'other.model.test', timedOut: false }],
    ]) {
      const h = harness(rows);
      await expect(h.service.initialize({})).resolves.toEqual({ initialized: true });
      expect(h.mark).toHaveBeenCalledWith(undefined, rows);
    }
  });
  it('确定全部失败仍要求显式确认，未确认没有写入', async () => {
    const h = harness([{ ...timeout, timedOut: false }]);
    await expect(h.service.initialize({})).rejects.toMatchObject({
      response: { code: 'OFFLINE_NOT_ACKNOWLEDGED', sideEffectFree: true },
    });
    expect(h.mark).not.toHaveBeenCalled();
    await expect(h.service.initialize({ acknowledgeOffline: true })).resolves.toEqual({
      initialized: true,
    });
  });
});

describe('SYS代理字段验证', () => {
  it('只接收HTTP(S)完整URL，空值清空；错误定位原字段', () => {
    expect(
      ProxyConfigSchema.safeParse({ httpProxy: '', httpsProxy: 'http://user:pass@proxy.test:3128' })
        .success,
    ).toBe(true);
    for (const address of [
      'proxy.test:3128',
      'ftp://proxy.test',
      'http://',
      'http:// proxy.test',
    ]) {
      const result = ProxyConfigSchema.safeParse({ httpsProxy: address });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(['httpsProxy']);
    }
  });
});
