import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { FsGitAuthMaterializer } from '../../../packages/modules/credential/src/infrastructure/git/git-auth.materializer';
import { GitLsRemoteTester } from '../../../packages/modules/credential/src/infrastructure/git/git-ls-remote.tester';
import { SecretMaterial } from '../../../packages/modules/credential/src/domain/value-objects/secret-material.vo';
import { EncryptedBlob } from '../../../packages/modules/credential/src/domain/value-objects/encrypted-blob.vo';

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  }
});

const packet = (body: string): string =>
  (Buffer.byteLength(body) + 4).toString(16).padStart(4, '0') + body;

describe('git test needs an actual repository, rather than a host root', () => {
  it('accepts the same synthetic valid token at its repo and reproduces the root false permission result', async () => {
    const token = 'synthetic-fixture-token';
    const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    let authenticatedRepoRequests = 0;
    server = createServer((request, response) => {
      if (!request.url?.startsWith('/actual-repo.git/info/refs')) {
        response.writeHead(404);
        response.end('repository not found');
        return;
      }
      if (request.headers.authorization !== authorization) {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture git"' });
        response.end();
        return;
      }
      authenticatedRepoRequests++;
      const hash = '1'.repeat(40);
      response.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' });
      response.end(
        packet('# service=git-upload-pack\n') +
          '0000' +
          packet(`${hash} HEAD\0symref=HEAD:refs/heads/main\n`) +
          packet(`${hash} refs/heads/main\n`) +
          '0000',
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture address missing');
    const host = `127.0.0.1:${address.port}`;
    const materializer = new FsGitAuthMaterializer({
      decrypt: async () => SecretMaterial.fromUtf8(token),
      encrypt: async () => {
        throw new Error('unused');
      },
    });
    const auth = await materializer.materialize({
      obtainedVia: 'git-https-token',
      secret: new EncryptedBlob('fixture', 'iv', 'tag', 'key'),
      host,
      allowedHosts: [host],
      scheme: 'http',
    });
    try {
      const tester = new GitLsRemoteTester();
      const actual = await tester.lsRemote({
        url: `http://${host}/actual-repo.git`,
        env: auth.env,
      });
      expect(actual).toEqual({ ok: true });
      expect(authenticatedRepoRequests).toBeGreaterThan(0);
      const invalid = await tester.lsRemote({
        url: `http://${host}/actual-repo.git`,
        env: { ...auth.env, GIT_TOKEN: 'invalid-synthetic-token' },
      });
      expect(invalid).toMatchObject({ ok: false, errorCode: 'CLONE_FAILED_PERMISSION' });
      const root = await tester.lsRemote({ url: `http://${host}/`, env: auth.env });
      expect(root).toMatchObject({ ok: false, errorCode: 'CLONE_FAILED_PERMISSION' });
      expect(JSON.stringify(actual)).not.toContain('refs/heads');
      expect(JSON.stringify(root)).not.toContain(token);
    } finally {
      await auth.dispose();
    }
  });
});
