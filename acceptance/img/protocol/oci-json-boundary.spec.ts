import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { OciRegistryClient } from '../../../packages/modules/image/src/infrastructure/spec/oci-registry.client';
import { assertDefined } from '../../support/assert-defined';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

async function registry(manifest: unknown, config: unknown, token?: unknown) {
  const requests: string[] = [];
  const raw = Buffer.from(JSON.stringify(manifest));
  const server = createServer((request, response) => {
    const path = assertDefined(request.url);
    requests.push(path);
    response.setHeader('Content-Type', 'application/json');
    if (path.startsWith('/token')) {
      response.end(JSON.stringify(token));
      return;
    }
    if (token !== undefined && request.headers.authorization !== 'Bearer synthetic-token') {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Registry fixture did not bind');
      response.writeHead(401, {
        'WWW-Authenticate': `Bearer realm="http://127.0.0.1:${address.port}/token"`,
      });
      response.end('{}');
      return;
    }
    response.end(path.includes('/manifests/') ? raw : JSON.stringify(config));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Registry fixture did not bind');
  return {
    name: `127.0.0.1:${address.port}/test/image`,
    client: new OciRegistryClient(),
    requests,
    raw,
  };
}

describe('OCI real HTTP metadata decoding', () => {
  it.each([null, [], { config: { digest: 1 } }, { manifests: {} }])(
    'rejects malformed manifest before requesting a blob: %j',
    async (manifest) => {
      const f = await registry(manifest, {});
      await expect(f.client.fetchManifest(f.name, 'latest')).rejects.toMatchObject({
        code: 'REGISTRY_UNREACHABLE',
      });
      expect(f.requests).toHaveLength(1);
    },
  );
  it.each([{ config: { Env: [1] } }, { rootfs: { diff_ids: [1] } }, { config: { Labels: [] } }])(
    'rejects malformed nested config after only metadata requests: %j',
    async (config) => {
      const f = await registry({ config: { digest: 'sha256:config-fixture' } }, config);
      await expect(f.client.fetchManifest(f.name, 'latest')).rejects.toMatchObject({
        code: 'REGISTRY_UNREACHABLE',
      });
      expect(f.requests).toHaveLength(2);
    },
  );
  it('retains unknown config fields, null commands, labels and exact raw manifest bytes', async () => {
    const config = {
      extension: { opaque: true },
      rootfs: { type: 'layers', diff_ids: ['sha256:layer'], extension: 1 },
      config: {
        Env: ['A=b'],
        Entrypoint: null,
        Cmd: null,
        Labels: { 'vendor.extension': 'retained' },
        extension: ['opaque'],
      },
    };
    const f = await registry(
      { config: { digest: 'sha256:config-fixture' }, extension: { opaque: true } },
      config,
    );
    expect((await f.client.fetchManifest(f.name, 'latest')).config).toMatchObject(config);
    expect(f.requests).toHaveLength(2);
    const copied = await f.client.fetchRawManifest(f.name, 'latest');
    expect(copied.raw).toEqual(f.raw);
    expect(f.requests).toHaveLength(3);
    expect(
      f.requests.every(
        (path) => path.includes('/manifests/') || path.includes('/blobs/sha256:config-fixture'),
      ),
    ).toBe(true);
  });
  it('rejects an invalid token before retrying the protected resource', async () => {
    const f = await registry(
      { config: { digest: 'sha256:config-fixture' } },
      {},
      { token: { wrong: true } },
    );
    await expect(f.client.fetchManifest(f.name, 'latest')).rejects.toMatchObject({
      code: 'REGISTRY_UNREACHABLE',
    });
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]).toContain('/token');
  });
  it('accepts a valid access_token fallback and retains the cached authentication path', async () => {
    const f = await registry(
      { config: { digest: 'sha256:config-fixture' } },
      {},
      { access_token: 'synthetic-token', extension: true },
    );
    expect((await f.client.fetchManifest(f.name, 'latest')).config).toEqual({});
    expect(f.requests).toHaveLength(4);
    expect(f.requests.filter((path) => path.startsWith('/token'))).toHaveLength(1);
  });
});
