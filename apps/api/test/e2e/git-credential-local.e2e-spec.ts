import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { AppModule } from '../../src/app.module';
import {
  findPrivateIpv4,
  gitHttpBackendPath,
  opensslAvailable,
  startLocalGitServer,
  type LocalGitServer,
} from './local-git-https-server';

/**
 * S3 REGRESSION — the DEFAULT-RUNNING twin of git-credential.e2e-spec.ts. That spec
 * needs a REAL PAT + a REAL private repo (env-gated, loud-skip); this one stands up
 * a LOCAL basic-auth HTTPS git remote so CI can PERMANENTLY pin three judgements
 * with no external network and no secrets:
 *   ① wrong token  → clone/test MUST fail as PERMISSION (not NETWORK),
 *   ② right token  → clone/test MUST succeed and land real files,
 *   ③ execution is HERMETIC — an inline wrong token cannot be rescued by any ambient
 *      credential (macOS keychain / ~/.gitconfig): if it could, ① would fake-pass.
 *
 * See local-git-https-server.ts for the four scaffolding traps (smart http, HTTPS+CA,
 * private non-loopback IP, port-carrying authority). Skips LOUDLY — never fake-passes
 * — when openssl / git-http-backend / a private IPv4 are unavailable.
 */
const ip = findPrivateIpv4();
const backend = gitHttpBackendPath();
const openssl = opensslAvailable();
const ready = Boolean(ip && backend && openssl);

if (!ready) {
  console.warn(
    `\n[33m[git-credential-local.e2e] SKIPPED — prerequisites missing ` +
      `(privateIpv4=${Boolean(ip)} gitHttpBackend=${Boolean(backend)} openssl=${openssl}). ` +
      'This is the LOCAL private-repo clone-with-credential regression. NOT fake-passed.[0m\n',
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

describe.skipIf(!ready)('LOCAL private git remote → clone with credential (S3 regression)', () => {
  let app: INestApplication;
  let dataRoot: string;
  let server: LocalGitServer;
  const priorCaInfo = process.env.GIT_SSL_CAINFO;

  beforeAll(async () => {
    server = await startLocalGitServer({ ip: ip!, gitHttpBackend: backend! });
    // The clone/ls-remote child inherits GIT_SSL_CAINFO (kept by the cloner guard),
    // so it trusts our self-signed CA WITHOUT disabling TLS validation.
    process.env.GIT_SSL_CAINFO = server.caPath;

    process.env.DATABASE_URL = ':memory:';
    process.env.PLATFORM_MASTER_KEY = Buffer.from(
      '0123456789abcdef0123456789abcdef',
    ).toString('base64');
    dataRoot = mkdtempSync(resolve(process.cwd(), 'tmp-gitcred-local-'));
    process.env.DATA_ROOT = dataRoot;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await server?.close();
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
    if (priorCaInfo === undefined) delete process.env.GIT_SSL_CAINFO;
    else process.env.GIT_SSL_CAINFO = priorCaInfo;
  });

  it('NO credential → clone fails as PERMISSION (401), not NETWORK', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'local-nocred', sourceType: 'git', repoUrl: server.repoUrl })
      .expect(202);
    expect(await waitClone(app, created.body.id as string)).toBe('failed');
    const failed = await request(app.getHttpServer()).get(`/api/projects/${created.body.id}`);
    expect(failed.body.cloneErrorCode).toBe('CLONE_FAILED_PERMISSION');
  }, 90_000);

  it('store token → test ok → clone READY with real files → masked list hides the token', async () => {
    const host = server.host;

    const stored = await request(app.getHttpServer())
      .post('/api/credentials/git')
      .send({ type: 'https-token', secret: server.token, platform: 'other', allowedHosts: [host] })
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
      .send({ name: 'local-withcred', sourceType: 'git', repoUrl: server.repoUrl })
      .expect(202);
    expect(await waitClone(app, ok.body.id as string)).toBe('ready');

    const baseline = resolve(dataRoot, 'baselines', ok.body.id as string);
    const entries = readdirSync(baseline);
    expect(entries).toContain('README.md'); // real cloned file landed

    const list = await request(app.getHttpServer()).get('/api/credentials?kind=git').expect(200);
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
});
