import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { AppModule } from '../../src/app.module';

/**
 * Project context REST e2e (docs/backend/03 §7, shared/10 §6). Empty projects are
 * `ready` at once; git projects clone in the background (202) with progress; the
 * failure path (bad URL) → retry → convert-to-empty works offline. The successful
 * clone of a PUBLIC repo needs network — it SKIPS LOUDLY when offline.
 *
 * Asserts the product rule that `ProjectDto` never carries `repoUrl`.
 */
const PUBLIC_REPO = process.env.E2E_PUBLIC_REPO ?? 'https://github.com/octocat/Hello-World.git';

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
if (!netUp) {
  console.warn(
    '\n[33m[projects.e2e] github.com unreachable — the SUCCESSFUL-clone case is SKIPPED (offline). Failure/retry/convert still run.[0m\n',
  );
}

let app: INestApplication;
let dataRoot: string;

async function poll(id: string, want: string, ms = 60_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  let body: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const res = await request(app.getHttpServer()).get(`/api/projects/${id}`).expect(200);
    body = res.body;
    if (body.cloneStatus === want) return body;
    if (body.cloneStatus === 'failed' && want !== 'failed') {
      throw new Error(`unexpected failed: ${JSON.stringify(body)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`project ${id} never reached ${want} (last=${JSON.stringify(body)})`);
}

beforeAll(async () => {
  process.env.DATABASE_URL = ':memory:';
  dataRoot = mkdtempSync(resolve(process.cwd(), 'tmp-projects-e2e-'));
  process.env.DATA_ROOT = dataRoot;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
  await app.listen(0);
}, 30_000);

afterAll(async () => {
  await app?.close();
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
});

describe('projects REST', () => {
  it('empty project is ready immediately and never exposes repoUrl', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'empty-one', sourceType: 'empty' })
      .expect(202);
    expect(res.body.cloneStatus).toBe('ready');
    expect(res.body.sourceType).toBe('empty');
    expect(res.body.taskCount).toBe(0);
    // minimal DTO (shared/10 §7): no source, no internal fields
    expect(res.body).not.toHaveProperty('repoUrl');
    expect(res.body).not.toHaveProperty('repoBranch');
    expect(res.body).not.toHaveProperty('baselineSizeBytes');
    expect(res.body).not.toHaveProperty('workspaceMode');
    expect(res.body).not.toHaveProperty('updatedAt');

    const id = res.body.id as string;
    const got = await request(app.getHttpServer()).get(`/api/projects/${id}`).expect(200);
    expect(got.body).not.toHaveProperty('repoUrl');

    const list = await request(app.getHttpServer()).get('/api/projects').expect(200);
    expect((list.body as Array<{ id: string }>).map((p) => p.id)).toContain(id);

    await request(app.getHttpServer()).delete(`/api/projects/${id}`).send({}).expect(204);
    await request(app.getHttpServer()).get(`/api/projects/${id}`).expect(404);
  });

  it('rejects git without repoUrl (400) and empty with repoUrl (400)', async () => {
    await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'bad-a', sourceType: 'git' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'bad-b', sourceType: 'empty', repoUrl: 'https://h/x.git' })
      .expect(400);
  });

  it('blocks SSRF to loopback / link-local / metadata with 400 (03 §7.3 C4)', async () => {
    // loopback + cloud metadata + link-local are NEVER a git host — always rejected.
    for (const repoUrl of [
      'http://169.254.169.254/x.git',
      'http://localhost/x.git',
      'http://127.0.0.1/x.git',
    ]) {
      await request(app.getHttpServer())
        .post('/api/projects')
        .send({ name: `ssrf-${Math.random()}`, sourceType: 'git', repoUrl })
        .expect(400);
    }
  });

  it('ALLOWS a private-LAN repoUrl (internal self-hosted git is a core use case, C4)', async () => {
    // 10.x/192.168.x are legitimate internal git hosts on a single-machine deploy;
    // creation is accepted (202). Delete immediately to cancel the background clone.
    const res = await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: `lan-${Math.random()}`, sourceType: 'git', repoUrl: 'http://192.168.199.1/x.git' })
      .expect(202);
    await request(app.getHttpServer()).delete(`/api/projects/${res.body.id}`).send({}).expect(204);
  });

  it('I-PRJ-4: unique name (409), name length ≤40 (400)', async () => {
    await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'uniq-name', sourceType: 'empty' })
      .expect(202);
    // duplicate name → 409
    const dup = await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'uniq-name', sourceType: 'empty' })
      .expect(409);
    expect(String(dup.body.message ?? '')).toMatch(/already exists/i);
    // name > 40 chars → 400 (zod)
    await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'x'.repeat(41), sourceType: 'empty' })
      .expect(400);
  });

  it('failed clone (bad host) → retry → convert-to-empty (offline-safe)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'bad-url', sourceType: 'git', repoUrl: 'https://nonexistent.invalid/x.git' })
      .expect(202);
    const id = res.body.id as string;
    expect(res.body.cloneStatus).toBe('cloning');

    const failed = await poll(id, 'failed');
    expect(['CLONE_FAILED_NETWORK', 'CLONE_FAILED_PERMISSION']).toContain(failed.cloneErrorCode);

    // retry re-attempts (and fails again on the same bad host)
    await request(app.getHttpServer()).post(`/api/projects/${id}/retry-clone`).expect(202);
    await poll(id, 'failed');

    // convert the failed git project into an empty one → ready
    const converted = await request(app.getHttpServer())
      .post(`/api/projects/${id}/convert-to-empty`)
      .expect(200);
    expect(converted.body.cloneStatus).toBe('ready');
    expect(converted.body.sourceType).toBe('empty');
    expect(converted.body.cloneErrorCode).toBeNull();
  }, 60_000);

  it.skipIf(!netUp)(
    'clones a public repo → ready with real baseline files',
    async () => {
      const res = await request(app.getHttpServer())
        .post('/api/projects')
        .send({ name: 'hello', sourceType: 'git', repoUrl: PUBLIC_REPO })
        .expect(202);
      const id = res.body.id as string;
      expect(res.body.cloneStatus).toBe('cloning');

      const ready = await poll(id, 'ready', 120_000);
      expect(ready.cloneStatus).toBe('ready');
      expect(ready.taskCount).toBe(0);

      // the baseline dir on disk really holds the cloned repo
      const baselineDir = resolve(dataRoot, 'baselines', id);
      expect(existsSync(baselineDir)).toBe(true);
      const entries = readdirSync(baselineDir);
      expect(entries).toContain('README'); // octocat/Hello-World has a README
      expect(entries).toContain('.git');
    },
    120_000,
  );

  // LAST: fills up to the 50-project cap, so it must not precede the other cases.
  it('I-PRJ-4: at most 50 projects (over the cap → 400)', async () => {
    let limited = false;
    for (let i = 0; i < 70; i++) {
      const res = await request(app.getHttpServer())
        .post('/api/projects')
        .send({ name: `bulk-${i}-${Math.random().toString(36).slice(2)}`, sourceType: 'empty' });
      if (res.status === 400 && /limit reached/i.test(String(res.body.message ?? ''))) {
        limited = true;
        break;
      }
      expect(res.status).toBe(202);
    }
    expect(limited).toBe(true);
  }, 30_000);
});
