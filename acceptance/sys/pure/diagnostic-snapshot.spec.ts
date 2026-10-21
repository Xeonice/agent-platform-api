import { describe, expect, it } from 'vitest';
import type { ConnectivityResult } from '@platform/contracts';
import { outboundVerdict } from '../../../apps/api/src/platform/system/diagnostics/checks/outbound-network.check';

const model: ConnectivityResult = { target: 'model.example.test', modelApi: true, ok: false };
const registry: ConnectivityResult = { target: 'registry.example.test', modelApi: false, ok: true };

describe('diagnostic summaries describe their targets without admitting or denying tasks', () => {
  it('keeps an empty observation unknown instead of inventing success or Infinity latency', () => {
    const result = outboundVerdict([]);
    expect(result).toMatchObject({
      status: 'warn',
      headline: '尚无联网探测结果',
      detail: { results: [] },
    });
    expect(result.detailText).not.toContain('Infinity');
  });

  it('retains failed target evidence without claiming every Agent is unavailable', () => {
    const rows = [model, registry];
    const result = outboundVerdict(rows);
    expect(result.status).toBe('fail');
    expect(result.headline).toBe('本次模型 API 探测未通过');
    expect(result.detail).toEqual({ results: rows });
    expect(result.detailText).toContain('任务实际连通性以其配置为准');
    expect(JSON.stringify(result)).not.toContain('Agent 不可用');
  });

  it('preserves timeout uncertainty and keeps it separate from a definite failed target', () => {
    const timedOut = { ...model, timedOut: true };
    const result = outboundVerdict([timedOut]);
    expect(result.status).toBe('warn');
    expect(result.detailText).toContain('不等于连不上');
    expect(result.detail).toEqual({ results: [timedOut] });
    const mixed = outboundVerdict([model, { ...timedOut, target: 'slow.example.test' }]);
    expect(mixed.detailText).toContain('未在超时时限内应答');
    expect(mixed.detailText).toContain('任务实际连通性以其配置为准');
  });

  it('limits successful and registry-only summaries to the actual checked destinations', () => {
    const success = outboundVerdict([{ ...model, ok: true, latencyMs: 12 }, registry]);
    expect(success).toMatchObject({ status: 'ok', headline: '本次探测目标均已通过' });
    expect(success.detailText).toContain('最快 12ms');
    expect(outboundVerdict([registry]).detailText).not.toContain('最快');
    const failedRegistry = outboundVerdict([
      { ...model, ok: true },
      { ...registry, ok: false },
    ]);
    expect(failedRegistry).toMatchObject({ status: 'warn', headline: '镜像下载源本次检查未通过' });
    expect(JSON.stringify(failedRegistry)).not.toContain('Agent 可用');
    const noModels = outboundVerdict([{ ...registry, ok: false }]);
    expect(noModels.detailText).not.toContain('模型 API 目标检查通过');
  });
});
