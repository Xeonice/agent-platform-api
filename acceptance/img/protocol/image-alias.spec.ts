import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ImageManifestSchema } from '@platform/contracts';
import { createPlatform } from '../../support/platform-app';

let platform: Awaited<ReturnType<typeof createPlatform>>;
beforeAll(async () => {
  platform = await createPlatform();
}, 60_000);
afterAll(async () => {
  await platform?.close();
});
const http = () => request(platform.app.getHttpServer());

describe('AC-IMG-060.2/060.3/060.4/060.5/060.6 · real Nest alias wire contract', () => {
  it('registers, renames via any version, clears and keeps one shared nullable value across list variants', async () => {
    const first = await http()
      .post('/api/images')
      .send({ ref: 'registry.test/protocol-agent:v1', alias: '  构建 Agent  ' })
      .expect(201);
    const original = ImageManifestSchema.parse(first.body.manifest);
    expect(original.imageAlias).toBe('构建 Agent');
    const second = await http()
      .post('/api/images')
      .send({ ref: 'registry.test/protocol-agent:v2' })
      .expect(201);
    expect(second.body.manifest.imageAlias).toBe('构建 Agent');
    const renamed = await http()
      .patch(`/api/images/${second.body.manifest.id}`)
      .send({ alias: '联调环境' })
      .expect(200);
    expect(ImageManifestSchema.parse(renamed.body)).toMatchObject({
      imageAlias: '联调环境',
      ref: second.body.manifest.ref,
      digest: second.body.manifest.digest,
      isActive: second.body.manifest.isActive,
      validationStatus: second.body.manifest.validationStatus,
      imageConfig: null,
    });
    for (const query of ['', '?runtimeId=codex', '?provider=aio']) {
      const list = await http().get(`/api/images${query}`).expect(200);
      const versions = ImageManifestSchema.array()
        .parse(list.body)
        .filter((manifest) => manifest.imageId === original.imageId);
      expect(versions).toHaveLength(2);
      expect(versions.every((manifest) => manifest.imageAlias === '联调环境')).toBe(true);
    }
    await http()
      .patch(`/api/images/${original.id}`)
      .send({ isActive: false })
      .expect(200)
      .expect((response) => {
        expect(response.body.imageAlias).toBe('联调环境');
      });
    await http()
      .patch(`/api/images/${original.id}`)
      .send({ alias: '    ' })
      .expect(200)
      .expect((response) => {
        expect(response.body.imageAlias).toBeNull();
      });
    await http()
      .patch(`/api/images/${original.id}`)
      .send({ alias: '😀'.repeat(64) })
      .expect(200);
    await http()
      .patch(`/api/images/${original.id}`)
      .send({ alias: null })
      .expect(200)
      .expect((response) => {
        expect(response.body.imageAlias).toBeNull();
      });
    await http()
      .post('/api/images')
      .send({ ref: 'registry.test/protocol-agent:v1' })
      .expect(200)
      .expect((response) => {
        expect(response.body.manifest.imageAlias).toBeNull();
      });
  });

  it('allows duplicates but refuses invalid aliases, implicit renames and mixed invalid config without writes', async () => {
    const first = await http()
      .post('/api/images')
      .send({ ref: 'registry.test/protocol-shared:v1', alias: '研发' })
      .expect(201);
    const second = await http()
      .post('/api/images')
      .send({ ref: 'registry.test/protocol-other:v1', alias: '研发' })
      .expect(201);
    expect(second.body.manifest.imageId).not.toBe(first.body.manifest.imageId);
    const before = (await http().get('/api/images').expect(200)).body;
    for (const alias of [
      '😀'.repeat(65),
      '\t研发',
      '研发\n',
      '\r研发',
      '\u0000研发',
      '\u0085研发',
      '\u2028研发',
      '研发\u2029',
    ]) {
      const response = await http()
        .patch(`/api/images/${first.body.manifest.id}`)
        .send({ alias })
        .expect(400);
      expect(response.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        retryable: false,
        sideEffectFree: true,
      });
      expect(response.body.details).toContainEqual(
        expect.objectContaining({ path: 'alias', code: 'custom' }),
      );
    }
    const conflict = await http()
      .post('/api/images')
      .send({ ref: 'registry.test/protocol-shared:v2', alias: '不同值' })
      .expect(400);
    expect(conflict.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      retryable: false,
      sideEffectFree: true,
    });
    expect(conflict.body.details).toEqual([
      { path: 'alias', code: 'custom', message: '这张镜像已注册，请在镜像卡片中编辑别名' },
    ]);
    await http()
      .post('/api/images')
      .send({ ref: 'registry.test/protocol-shared:v1', alias: null })
      .expect(400);
    await http()
      .patch(`/api/images/${first.body.manifest.id}`)
      .send({
        alias: '新值',
        isActive: false,
        imageConfig: { env: [{ key: 'HOME', value: 'forbidden' }] },
      })
      .expect(400);
    expect((await http().get('/api/images').expect(200)).body).toEqual(before);
    await http()
      .patch('/api/images/nonexistent-manifest')
      .send({ alias: '研发' })
      .expect(404)
      .expect((response) => {
        expect(response.body.code).toBe('NOT_FOUND');
      });
    await http()
      .post('/api/images')
      .send({ ref: 'registry.test/protocol-shared:v1', alias: '  研发  ' })
      .expect(200);
  });
});
