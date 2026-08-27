import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { configurePlatformApp } from '../../src/bootstrap/configure-app';
import { useEnv } from './_env';
import {
  findPrivateIpv4,
  gitHttpBackendPath,
  opensslAvailable,
  startLocalGitHttpServer,
  startLocalGitServer,
  type LocalGitServer,
} from './local-git-https-server';

/**
 * S3 REGRESSION — the DEFAULT-RUNNING twin of git-credential.e2e-spec.ts. That spec
 * needs a REAL PAT + a REAL private repo (env-gated, loud-skip); this one stands up a
 * LOCAL basic-auth git remote so CI can PERMANENTLY pin four judgements with no
 * external network and no secrets:
 *   ① wrong token  → clone/test MUST fail as PERMISSION (not NETWORK),
 *   ② right token  → clone/test MUST succeed and land real files,
 *   ③ execution is HERMETIC — an inline wrong token cannot be rescued by any ambient
 *      credential (macOS keychain / ~/.gitconfig): if it could, ① would fake-pass,
 *   ④ SCHEME-AWARE — the SAME judgements hold over BOTH https AND plaintext http. The
 *      http group is the dedicated guard for the scheme-aware helper-key fix (03 §7.3
 *      C4): the materializer keys `credential.<scheme>://<authority>.helper`, so a
 *      `credential.https://…` helper would NOT fire for an `http://` remote and the
 *      token would be silently dropped. If that regressed, the http group's ② breaks.
 *
 * See local-git-https-server.ts for the scaffolding traps. Each group skips LOUDLY —
 * never fake-passes — when its prerequisites are missing. The http group needs NO
 * openssl (its whole point is no TLS).
 */
const ip = findPrivateIpv4();
const backend = gitHttpBackendPath();
const openssl = opensslAvailable();

interface Variant {
  scheme: 'http' | 'https';
  ready: boolean;
  missing: string;
  start: () => Promise<LocalGitServer>;
}

const variants: Variant[] = [
  {
    scheme: 'https',
    ready: Boolean(ip && backend && openssl),
    missing: `privateIpv4=${Boolean(ip)} gitHttpBackend=${Boolean(backend)} openssl=${openssl}`,
    start: () => startLocalGitServer({ ip: ip!, gitHttpBackend: backend! }),
  },
  {
    scheme: 'http',
    ready: Boolean(ip && backend), // no openssl — plaintext http has no TLS
    missing: `privateIpv4=${Boolean(ip)} gitHttpBackend=${Boolean(backend)}`,
    start: () => startLocalGitHttpServer({ ip: ip!, gitHttpBackend: backend! }),
  },
];

for (const variant of variants) {
  if (!variant.ready) {
    // The dominant real-world skip cause is a runner with ONLY loopback (no private
    // IPv4). We deliberately cannot fall back to 127.0.0.1: the SSRF gate BLOCKS
    // loopback (it is meant to), so a loopback bind could not stand in for a private
    // host without defeating the very behaviour under test. There is no clean,
    // unprivileged, portable way to synthesise a private IP in CI (adding an alias
    // needs root). So we keep a LOUD skip and state plainly that the regression is
    // UNCOVERED on this runner — we do NOT fake a pass.
    const noPrivateIp = !ip;
    console.warn(
      `\n[33m[git-credential-local.e2e:${variant.scheme}] SKIPPED — prerequisites missing ` +
        `(${variant.missing}). This is the LOCAL private-repo clone-with-credential ` +
        'regression. NOT fake-passed.' +
        (noPrivateIp
          ? ' NOTE: this runner has NO private (non-loopback) IPv4 — the private-repo ' +
            'clone-with-credential path is UNCOVERED here; run on a host/CI with a ' +
            '10/172.16-31/192.168 address to exercise it.'
          : '') +
        '[0m\n',
    );
  }

  describe.skipIf(!variant.ready)(
    `LOCAL private git remote (${variant.scheme}) → clone with credential (S3 regression)`,
    () => {
      let app: INestApplication;
      let dataRoot: string;
      let server: LocalGitServer;
      let restoreEnv: () => void;

      beforeAll(async () => {
        server = await variant.start();
        dataRoot = mkdtempSync(resolve(process.cwd(), `tmp-gitcred-local-${variant.scheme}-`));
        // HTTPS only: the clone/ls-remote child inherits GIT_SSL_CAINFO (kept by the
        // cloner guard) so it trusts our self-signed CA WITHOUT disabling TLS
        // validation. Plaintext http needs no CA — `undefined` UNSETS it, and the
        // restore puts back whatever the environment really had (_env.ts).
        restoreEnv = useEnv({
          GIT_SSL_CAINFO: server.caPath ?? undefined,
          DATABASE_URL: ':memory:',
          PLATFORM_MASTER_KEY: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
          DATA_ROOT: dataRoot,
        });

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        configurePlatformApp(app);
        await app.init();
        await app.listen(0);
      }, 60_000);

      afterAll(async () => {
        await app?.close();
        await server?.close();
        if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
        restoreEnv?.();
      });

      it('NO credential → clone fails as PERMISSION (401), not NETWORK', async () => {
        const created = await request(app.getHttpServer())
          .post('/api/projects')
          .send({
            name: `local-nocred-${variant.scheme}`,
            sourceType: 'git',
            repoUrl: server.repoUrl,
          })
          .expect(202);
        expect(await waitClone(app, created.body.id as string)).toBe('failed');
        const failed = await request(app.getHttpServer()).get(`/api/projects/${created.body.id}`);
        expect(failed.body.cloneErrorCode).toBe('CLONE_FAILED_PERMISSION');
      }, 90_000);

      it('store token → test ok → clone READY with real files → masked list hides the token', async () => {
        const host = server.host;

        const stored = await request(app.getHttpServer())
          .post('/api/credentials/git')
          .send({
            type: 'https-token',
            secret: server.token,
            platform: 'other',
            allowedHosts: [host],
          })
          .expect(201);
        expect(stored.body.id).toBeTruthy();
        expect(stored.body.maskedIdentifier).not.toContain(server.token);

        const test = await request(app.getHttpServer())
          .post('/api/credentials/git/test')
          .send({ source: 'stored', credentialId: stored.body.id, repoUrl: server.repoUrl })
          .expect(200);
        expect(test.body.ok).toBe(true);

        const ok = await request(app.getHttpServer())
          .post('/api/projects')
          .send({
            name: `local-withcred-${variant.scheme}`,
            sourceType: 'git',
            repoUrl: server.repoUrl,
          })
          .expect(202);
        expect(await waitClone(app, ok.body.id as string)).toBe('ready');

        const baseline = resolve(dataRoot, 'baselines', ok.body.id as string);
        const entries = readdirSync(baseline);
        expect(entries).toContain('README.md'); // real cloned file landed

        const list = await request(app.getHttpServer())
          .get('/api/credentials?kind=git')
          .expect(200);
        expect(JSON.stringify(list.body)).not.toContain(server.token);
      }, 90_000);

      it('HERMETIC: inline WRONG token → PERMISSION; inline CORRECT token → ok', async () => {
        const host = server.host;

        // This is the hermeticity guard: if any ambient credential (keychain / gitconfig)
        // could satisfy the remote, a wrong token would fake-pass here.
        const bad = await request(app.getHttpServer())
          .post('/api/credentials/git/test')
          .send({
            source: 'inline',
            type: 'https-token',
            secret: 'wrong_token_xxx',
            allowedHosts: [host],
            repoUrl: server.repoUrl,
          })
          .expect(200);
        expect(bad.body.ok).toBe(false);
        expect(bad.body.errorCode).toBe('CLONE_FAILED_PERMISSION');

        const good = await request(app.getHttpServer())
          .post('/api/credentials/git/test')
          .send({
            source: 'inline',
            type: 'https-token',
            secret: server.token,
            allowedHosts: [host],
            repoUrl: server.repoUrl,
          })
          .expect(200);
        expect(good.body.ok).toBe(true);
      }, 60_000);

      it('host ∉ allowedHosts → test refuses to carry the token', async () => {
        const res = await request(app.getHttpServer())
          .post('/api/credentials/git/test')
          .send({
            source: 'inline',
            type: 'https-token',
            secret: server.token,
            allowedHosts: ['other.example.com'],
            repoUrl: server.repoUrl,
          })
          .expect(200);
        expect(res.body.ok).toBe(false);
      }, 60_000);
    },
  );
}

async function waitClone(app: INestApplication, id: string, ms = 60_000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const got = await request(app.getHttpServer()).get(`/api/projects/${id}`);
    const status = got.body?.cloneStatus as string | undefined;
    if (status === 'ready' || status === 'failed') return status;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`project ${id} clone never settled`);
}
