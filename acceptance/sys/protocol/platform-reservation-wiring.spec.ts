import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { PLATFORM_RESERVATIONS } from '@platform/contracts';
import { HelperContainerSession } from '@platform/runtime';
import { AuthHelperCheck } from '../../../apps/api/src/platform/system/diagnostics/checks/auth-helper.check';
import { createPlatform } from '../../support/platform-app';

let platform: Awaited<ReturnType<typeof createPlatform>>;
beforeAll(async () => {
  platform = await createPlatform();
  // The background preheat builds the helper through the fixture provider; settle it first so
  // the call log below only reflects what the reads themselves do.
  const session = platform.app.get(HelperContainerSession, { strict: false });
  await vi.waitFor(() => expect(session.status()).toMatchObject({ ready: true, starting: false }), {
    timeout: 10_000,
  });
});
afterAll(async () => {
  await platform?.close();
});
const http = () => request(platform.app.getHttpServer());

describe('the complete Nest assembly wires the resident helper reservation into scheduling', () => {
  it('the runtime module provides the reservation that the real allocator applies', async () => {
    expect(platform.app.get(PLATFORM_RESERVATIONS, { strict: false })).toEqual([
      { owner: 'auth-helper', label: '帐号登录环境', quota: { cores: 1, ramMb: 512, diskMb: 0 } },
    ]);
    const calls = [...platform.provider.calls];
    const resources = await http().get('/api/system/resources').expect(200);
    expect(resources.body.capacity.basis).toContain(
      '已为平台常驻的帐号登录环境预留 1 核 CPU、512 MB 内存',
    );
    const status = await http().get('/api/deployment/status').expect(200);
    expect(status.body.blockers).toMatchObject({ resourceAllocations: 0, sandboxes: 0 });
    expect(status.body.idle).toBe(true);
    expect(platform.provider.calls).toEqual(calls);
  });

  it('the helper diagnosis asks the provider one read-only question and changes nothing', async () => {
    const calls = [...platform.provider.calls];
    const result = await platform.app.get(AuthHelperCheck, { strict: false }).run();
    expect(result).toMatchObject({ status: 'ok', headline: '帐号登录可用' });
    expect(platform.provider.calls.slice(calls.length)).toEqual(['inspect']);
    expect(platform.app.get(HelperContainerSession, { strict: false }).status().ready).toBe(true);
  });
});
