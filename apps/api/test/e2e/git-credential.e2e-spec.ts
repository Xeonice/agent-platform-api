import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { platformValidationPipe } from '../../src/bootstrap/validation.pipe';

/**
 * S3 ACCEPTANCE (docs/backend/25 §4.4): a PRIVATE git repo is cloned using a REAL
 * credential materialized by the credential context, and the same repo FAILS as a
 * permission error with NO credential. Real repo + real PAT are supplied via env.
 *
 * Skips LOUDLY (never fake-passes) when the env is missing:
 *   E2E_GIT_PRIVATE_REPO = https url of a PRIVATE repo you can read with the PAT
 *   E2E_GIT_PAT          = a Personal Access Token with read access to that repo
 */
const PRIVATE_REPO = process.env.E2E_GIT_PRIVATE_REPO;
const PAT = process.env.E2E_GIT_PAT;

async function networkUp(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    await fetch('https://github.com', { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}
const netUp = await networkUp();
const ready = Boolean(PRIVATE_REPO && PAT && netUp);

if (!ready) {
  console.warn(
    `\n[33m[git-credential.e2e] SKIPPED — prerequisites missing ` +
      `(privateRepo=${Boolean(PRIVATE_REPO)} pat=${Boolean(PAT)} net=${netUp}). ` +
      'This is the private-repo clone-with-credential acceptance. NOT fake-passed.[0m\n',
  );
}

// The credential AUTHORITY (host, plus :port when non-default) — git ≥ 2.50 matches
// credentials port-sensitively, so allowedHosts must carry the non-default port
// (03 §7.3 C4). A self-hosted https remote on :8443 → 'host:8443'.
function hostOf(url: string): string {
  const u = new URL(url);
  const dflt = u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '';
  return u.port && u.port !== dflt ? `${u.hostname}:${u.port}` : u.hostname;
}

async function waitClone(app: INestApplication, id: string, ms = 120_000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const got = await request(app.getHttpServer()).get(`/api/projects/${id}`);
    const status = got.body?.cloneStatus as string | undefined;
    if (status === 'ready' || status === 'failed') return status;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`project ${id} clone never settled`);
}

describe.skipIf(!ready)('private git repo → clone with credential (S3)', () => {
  let app: INestApplication;
  let dataRoot: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = ':memory:';
    process.env.PLATFORM_MASTER_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString(
      'base64',
    );
    dataRoot = mkdtempSync(resolve(process.cwd(), 'tmp-gitcred-'));
    process.env.DATA_ROOT = dataRoot;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(platformValidationPipe());
    await app.init();
    await app.listen(0);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
  });

  it('fails a PRIVATE clone with NO credential (permission), then SUCCEEDS after storing the PAT', async () => {
    const host = hostOf(PRIVATE_REPO!);

    // 1) no credential yet → private clone must FAIL as permission (git 401/403).
    const noCred = await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'priv-nocred', sourceType: 'git', repoUrl: PRIVATE_REPO })
      .expect(202);
    expect(await waitClone(app, noCred.body.id as string)).toBe('failed');
    const failed = await request(app.getHttpServer()).get(`/api/projects/${noCred.body.id}`);
    expect(failed.body.cloneErrorCode).toBe('CLONE_FAILED_PERMISSION');

    // 2) store the PAT (https-token, host-scoped) and test the connection.
    const stored = await request(app.getHttpServer())
      .post('/api/credentials/git')
      .send({ type: 'https-token', secret: PAT, platform: 'github', allowedHosts: [host] })
      .expect(201);
    expect(stored.body.id).toBeTruthy();
    expect(stored.body.maskedIdentifier).not.toContain(PAT);

    const test = await request(app.getHttpServer())
      .post('/api/credentials/git/test')
      .send({ source: 'stored', credentialId: stored.body.id, repoUrl: PRIVATE_REPO })
      .expect(200);
    expect(test.body.ok).toBe(true);

    // 3) now a private clone SUCCEEDS and the files land in the baseline dir.
    const ok = await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'priv-withcred', sourceType: 'git', repoUrl: PRIVATE_REPO })
      .expect(202);
    expect(await waitClone(app, ok.body.id as string)).toBe('ready');
    const baseline = resolve(dataRoot, 'baselines', ok.body.id as string);
    const entries = readdirSync(baseline);
    expect(entries.some((f) => f !== '.git')).toBe(true); // real files landed

    // 4) the masked list never leaks the PAT.
    const list = await request(app.getHttpServer()).get('/api/credentials?kind=git').expect(200);
    expect(JSON.stringify(list.body)).not.toContain(PAT);
  }, 300_000);

  it('inline test-before-save: wrong token → permission, correct token → ok', async () => {
    const host = hostOf(PRIVATE_REPO!);
    const bad = await request(app.getHttpServer())
      .post('/api/credentials/git/test')
      .send({
        source: 'inline',
        type: 'https-token',
        secret: 'ghp_wrongtoken000000',
        allowedHosts: [host],
        repoUrl: PRIVATE_REPO,
      })
      .expect(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.errorCode).toBe('CLONE_FAILED_PERMISSION');

    const good = await request(app.getHttpServer())
      .post('/api/credentials/git/test')
      .send({
        source: 'inline',
        type: 'https-token',
        secret: PAT,
        allowedHosts: [host],
        repoUrl: PRIVATE_REPO,
      })
      .expect(200);
    expect(good.body.ok).toBe(true);
  }, 60_000);

  it('rejects carrying a credential to a host outside allowedHosts (C3)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/credentials/git/test')
      .send({
        source: 'inline',
        type: 'https-token',
        secret: PAT,
        allowedHosts: ['github.com'],
        repoUrl: 'https://evil.example.com/x.git',
      })
      .expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.errorCode).toBe('CLONE_FAILED_PERMISSION');
  }, 60_000);
});
