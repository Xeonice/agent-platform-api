import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  IMAGE_SPEC_REGISTRY,
  ImageManifestSchema,
  type ImageSpecRegistry,
} from '@platform/contracts';
import { createPlatform } from '../../support/platform-app';

let platform: Awaited<ReturnType<typeof createPlatform>>;
beforeAll(async () => {
  platform = await createPlatform();
  const provider = platform.app.get<ImageSpecRegistry>(IMAGE_SPEC_REGISTRY).get('local-metadata');
  const original = provider.resolve.bind(provider);
  provider.resolve = async (ref) => {
    const resolved = await original(ref);
    if (ref.includes('/versions-wire:')) {
      resolved.manifest.runtimeVersions = {
        codex: '0.163.0',
        'claude-code': '2.1.302-rc.1+arm64',
      };
    }
    return resolved;
  };
}, 60_000);
afterAll(async () => {
  await platform?.close();
});
const http = () => request(platform.app.getHttpServer());

describe('AC-IMG-062.1/062.2/062.3 · actual Nest image version wire contract', () => {
  it('exposes declared versions through existing endpoints and keeps omitted third-party metadata compatible', async () => {
    const ref = 'registry.test/versions-wire:latest';
    const versions = { codex: '0.163.0', 'claude-code': '2.1.302-rc.1+arm64' };
    const preflight = await http().post('/api/images/validate').send({ ref }).expect(200);
    expect(preflight.body.runtimeVersions).toEqual(versions);
    const result = await http().post('/api/images').send({ ref }).expect(201);
    const manifest = ImageManifestSchema.parse(result.body.manifest);
    expect(manifest.runtimeVersions).toEqual(versions);
    expect(result.body.validation).toMatchObject({
      digest: manifest.digest,
      runtimeVersions: versions,
    });
    const listed = await http().get('/api/images').expect(200);
    expect(
      listed.body.find((row: { id: string }) => row.id === manifest.id).runtimeVersions,
    ).toEqual(versions);
    const validated = await http().post(`/api/images/${manifest.id}/validate`).send({}).expect(200);
    expect(validated.body).toMatchObject({ digestChanged: false, runtimeVersions: versions });
    const update = await http()
      .post(`/api/images/${manifest.id}/check-update`)
      .send({})
      .expect(200);
    expect(update.body.upstream.validation.runtimeVersions).toEqual(versions);
    const patched = await http()
      .patch(`/api/images/${manifest.id}`)
      .send({ alias: '版本声明' })
      .expect(200);
    expect(patched.body.runtimeVersions).toEqual(versions);
    const legacy = await http()
      .post('/api/images')
      .send({ ref: 'registry.test/versions-legacy:latest' })
      .expect(201);
    expect(legacy.body.manifest).toMatchObject({ runtimeVersions: {}, validationStatus: 'valid' });
    const { runtimeVersions: _versions, ...oldApiShape } = legacy.body.manifest;
    expect(ImageManifestSchema.parse(oldApiShape).runtimeVersions).toBeUndefined();
  });
});
