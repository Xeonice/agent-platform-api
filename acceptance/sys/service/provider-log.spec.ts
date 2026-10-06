import { Readable } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import {
  ProviderLogService,
  belongsToProvider,
} from '../../../apps/api/src/platform/audit/provider-log.service';

describe('沙箱环境日志原位读取', () => {
  it('只返回明确属于该环境的最新20行，不混入审计和其他环境', async () => {
    const chunks = [
      '2026-10-05T00:00:00.000Z INFO [System] aio只是配置说明\n',
      '2026-10-05T00:00:00.000Z INFO [BoxliteSandboxProvider] other\n',
      ...Array.from(
        { length: 25 },
        (_, index) => `2026-10-05T00:00:00.000Z INFO [AioSandboxProvider] line-${String(index)}\n`,
      ),
    ];
    const read = vi.fn(() => Readable.from(chunks));
    const result = await new ProviderLogService({ read }).read('aio');
    expect(result.lines).toHaveLength(20);
    expect(result.lines[0]).toContain('line-5');
    expect(result.lines.at(-1)).toContain('line-24');
    expect(result.unavailableReason).toBeUndefined();
    expect(read).toHaveBeenCalledWith({ maxBytes: 1024 * 1024 });
  });
  it('未启用、尚无文件、无该来源、读取失败分别如实呈现', async () => {
    expect((await new ProviderLogService().read('aio')).unavailableReason).toBe(
      '运行日志设施未启用。',
    );
    expect((await new ProviderLogService({ read: () => null }).read('aio')).unavailableReason).toBe(
      '尚未写入运行日志。',
    );
    expect(
      (await new ProviderLogService({ read: () => Readable.from(['[Other] log\n']) }).read('aio'))
        .unavailableReason,
    ).toBe('最近的运行日志中没有该沙箱环境的记录。');
    expect(
      (
        await new ProviderLogService({
          read: () => {
            throw new Error('disk failure');
          },
        }).read('aio')
      ).unavailableReason,
    ).toBe('运行日志读取失败，请重试。');
  });
  it('开放注册表 ID 转义，不允许正则通配；只认明确来源字段', () => {
    expect(belongsToProvider('[custom.xProvider] log', 'custom.x')).toBe(true);
    expect(belongsToProvider('[customXProvider] log', 'custom.x')).toBe(false);
    expect(belongsToProvider('{"provider":"aio"}', 'aio')).toBe(true);
    expect(belongsToProvider('provider=aio operation failed', 'aio')).toBe(true);
    expect(belongsToProvider('provider=aio2 operation failed', 'aio')).toBe(false);
  });
});
