import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  InitStatusDtoSchema,
  ProjectDtoSchema,
  RUNTIME_ADAPTER_REGISTRY,
  SandboxDtoSchema,
  type RuntimeAdapterRegistry,
} from '@platform/contracts';
import { createPlatform } from '../../support/platform-app';

describe('diagnostic target failures are initialization evidence, not task admission', () => {
  it('keeps initialization acknowledgement and current business refusals while admitting a task after failed probes', async () => {
    // Replace only external target metadata and the external resource provider.
    // The actual HTTP probe, initialization, SQLite and task services all run.
    let probes = 0;
    const target = createServer((incoming) => {
      probes += 1;
      incoming.socket.destroy();
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const address = target.address();
    if (address === null || typeof address === 'string') throw new Error('Missing local target');
    const authority = `127.0.0.1:${address.port}`;
    let closePlatform: () => Promise<void> = () => Promise.resolve();
    try {
      const platform = await createPlatform({
        SANDBOX_DEFAULT_IMAGE: `${authority}/platform/sandbox:latest`,
      });
      closePlatform = platform.close;
      const registry = platform.app.get<RuntimeAdapterRegistry>(RUNTIME_ADAPTER_REGISTRY);
      for (const adapter of registry.list())
        Object.defineProperty(adapter, 'connectivityTargets', { value: [authority] });
      const http = () => request(platform.app.getHttpServer());

      const refused = await http().post('/api/system/init').send({}).expect(409);
      expect(refused.body).toMatchObject({
        code: 'OFFLINE_NOT_ACKNOWLEDGED',
        sideEffectFree: true,
      });
      expect(refused.body.message).toContain('任务实际连通性以其配置为准');
      expect(refused.body.message).not.toContain('Agent 将不可用');
      const before = InitStatusDtoSchema.parse((await http().get('/api/system/init-status')).body);
      expect(before.initialized).toBe(false);
      expect(before.initializedAt).toBeUndefined();
      expect(before.lastConnectivityCheck).toBeUndefined();
      expect(before.lastConnectivityCheckAt).toBeUndefined();

      const confirmed = await http()
        .post('/api/system/init')
        .send({ acknowledgeOffline: true })
        .expect(201);
      const snapshot = InitStatusDtoSchema.parse(confirmed.body);
      expect(snapshot.initialized).toBe(true);
      expect(snapshot.lastConnectivityCheckAt).toEqual(expect.any(String));
      const models = snapshot.lastConnectivityCheck?.filter((row) => row.modelApi);
      expect(models).toEqual([
        expect.objectContaining({ target: authority, ok: false, modelApi: true }),
      ]);
      expect(probes).toBeGreaterThanOrEqual(4);

      const images = await http().get('/api/images').expect(200);
      expect(images.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ imageName: `${authority}/platform/sandbox` }),
        ]),
      );

      const project = ProjectDtoSchema.parse(
        (
          await http()
            .post('/api/projects')
            .send({ name: 'diagnostic snapshot', sourceType: 'empty' })
            .expect(202)
        ).body,
      );
      const callsBefore = platform.provider.calls.length;
      const currentRefusal = await http()
        .post('/api/sandboxes')
        .send({ projectId: project.id, runtime: 'unregistered-runtime' })
        .expect(400);
      expect(currentRefusal.body).toMatchObject({ code: 'UNKNOWN_RUNTIME', sideEffectFree: true });
      const missing = await http()
        .post('/api/sandboxes')
        .send({ projectId: 'missing-project', runtime: 'claude-code' })
        .expect((response) => expect(response.body.code).toBe('PROJECT_NOT_FOUND'))
        .expect(404);
      expect(missing.body).toMatchObject({ code: 'PROJECT_NOT_FOUND', sideEffectFree: true });

      const missingImage = await http()
        .post('/api/sandboxes')
        .send({
          projectId: project.id,
          runtime: 'claude-code',
          image: `${authority}/unregistered/image:latest`,
        })
        .expect(400);
      expect(missingImage.body).toMatchObject({
        code: 'IMAGE_NOT_REGISTERED',
        sideEffectFree: true,
      });
      expect(platform.provider.calls.length).toBe(callsBefore);
      expect((await http().get('/api/sandboxes').expect(200)).body).toEqual([]);

      const accepted = SandboxDtoSchema.parse(
        (
          await http()
            .post('/api/sandboxes')
            .send({ projectId: project.id, runtime: 'claude-code' })
            .expect(201)
        ).body,
      );
      await vi.waitFor(async () => {
        const task = SandboxDtoSchema.parse(
          (await http().get(`/api/sandboxes/${accepted.id}`).expect(200)).body,
        );
        expect(task.status).toBe('running');
      });
      // No task request rewrites the last failed detection into a made-up success.
      const after = InitStatusDtoSchema.parse((await http().get('/api/system/init-status')).body);
      expect(after.lastConnectivityCheck).toEqual(snapshot.lastConnectivityCheck);
      expect(after.lastConnectivityCheckAt).toBe(snapshot.lastConnectivityCheckAt);
      await http().delete(`/api/sandboxes/${accepted.id}`).send({ keepVolume: false }).expect(204);
    } finally {
      try {
        await closePlatform();
      } finally {
        await new Promise<void>((resolve, reject) =>
          target.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  });
});
