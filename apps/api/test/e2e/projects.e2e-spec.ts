import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { configurePlatformApp } from '../../src/bootstrap/configure-app';
import { AuditRepository } from '../../src/platform/audit/audit.repository';

/**
 * Project context REST e2e (docs/backend/03 §7, shared/10 §6). Empty projects are
 * `ready` at once; git projects clone in the background (202) with progress; the
 * failure path (bad URL) → retry → convert-to-empty works offline. The successful
 * clone of a PUBLIC repo needs network — it SKIPS LOUDLY when offline.
 *
 * ⚠️ THE 「never carries repoUrl」 ASSERTION THIS FILE USED TO MAKE IS GONE ON PURPOSE.
 * 10 §7.3 overturned that ruling: the project's read-only bar now shows the remote and
 * the baseline's freshness (P21-6), so `repoUrl` / `repoBranch` / `baselineSizeBytes` /
 * `updatedAt` are ON the DTO. What still must NOT leak is the pair below — a host
 * filesystem path and a v1.1 internal switch.
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
  configurePlatformApp(app);
  await app.init();
  await app.listen(0);
}, 30_000);

afterAll(async () => {
  await app?.close();
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
});

describe('projects REST', () => {
  it('empty project is ready immediately; its DTO carries updatedAt but no source', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'empty-one', sourceType: 'empty' })
      .expect(202);
    expect(res.body.cloneStatus).toBe('ready');
    expect(res.body.sourceType).toBe('empty');
    expect(res.body.taskCount).toBe(0);
    // `updatedAt` is unconditional (10 §7.3) — an empty project has one too.
    expect(typeof res.body.updatedAt).toBe('string');
    // …but an empty project has NO remote, so the three source/size fields are absent
    // rather than null (the wire contract writes them `?:`).
    expect(res.body).not.toHaveProperty('repoUrl');
    expect(res.body).not.toHaveProperty('repoBranch');
    // internal, and staying internal: a host path and the v1.1 shared-volume switch.
    expect(res.body).not.toHaveProperty('baselinePath');
    expect(res.body).not.toHaveProperty('workspaceMode');

    const id = res.body.id as string;
    const got = await request(app.getHttpServer()).get(`/api/projects/${id}`).expect(200);
    expect(got.body).not.toHaveProperty('repoUrl');

    // an empty project has no baseline repo to read refs from ⇒ [] (10 §6.2)
    const branches = await request(app.getHttpServer())
      .get(`/api/projects/${id}/branches`)
      .expect(200);
    expect(branches.body).toEqual([]);
    // …and nothing to sync: 409, not a silent no-op (27 §3 INVALID_STATE)
    const synced = await request(app.getHttpServer()).post(`/api/projects/${id}/sync`).send({});
    expect(synced.status).toBe(409);

    const list = await request(app.getHttpServer()).get('/api/projects').expect(200);
    expect((list.body as Array<{ id: string }>).map((p) => p.id)).toContain(id);

    await request(app.getHttpServer()).delete(`/api/projects/${id}`).send({}).expect(204);
    await request(app.getHttpServer()).get(`/api/projects/${id}`).expect(404);
  });

  it('a git project echoes its source back on the DTO (10 §7.3 overturns 「来源不外露」)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/projects')
      .send({
        name: 'source-echo',
        sourceType: 'git',
        repoUrl: 'https://example.invalid/org/repo.git',
        repoBranch: 'release/2.0',
      })
      .expect(202);
    // the clone will fail (host does not resolve) — irrelevant: these four come from
    // the row, which is written in the create transaction.
    expect(res.body.repoUrl).toBe('https://example.invalid/org/repo.git');
    expect(res.body.repoBranch).toBe('release/2.0');
    expect(typeof res.body.updatedAt).toBe('string');
    // still cloning ⇒ no baseline measured yet, and the branch list is empty rather
    // than an error the picker would have to special-case (10 §6.2).
    const branches = await request(app.getHttpServer())
      .get(`/api/projects/${res.body.id as string}/branches`)
      .expect(200);
    expect(branches.body).toEqual([]);

    await poll(res.body.id as string, 'failed');
    await request(app.getHttpServer())
      .delete(`/api/projects/${res.body.id as string}`)
      .send({})
      .expect(204);
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
      .send({
        name: `lan-${Math.random()}`,
        sourceType: 'git',
        repoUrl: 'http://192.168.199.1/x.git',
      })
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

  /**
   * 审计（13 §2.8.2）：四个改动型 POST 与 `DELETE` 此前**一个事件都不发**，
   * 实测删掉项目后 `audit_events.seq` 一点没动。
   */
  it('改动型操作与删除都留下审计行，且删除那条在项目消失之后仍在', async () => {
    const name = `audited-${Math.random().toString(36).slice(2, 8)}`;
    const created = await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name, sourceType: 'git', repoUrl: 'https://nonexistent.invalid/y.git' })
      .expect(202);
    const id = created.body.id as string;

    await poll(id, 'failed');
    await request(app.getHttpServer()).post(`/api/projects/${id}/retry-clone`).expect(202);
    await poll(id, 'failed');
    await request(app.getHttpServer()).post(`/api/projects/${id}/convert-to-empty`).expect(200);
    await request(app.getHttpServer()).delete(`/api/projects/${id}`).send({}).expect(204);
    // 主体真的没了 —— 下面那条审计行因此不可能是回查库拿到的名字。
    await request(app.getHttpServer()).get(`/api/projects/${id}`).expect(404);

    const rows = app
      .get(AuditRepository)
      .list({ limit: 500 })
      .items.filter((i) => i.subjectId === id);
    expect(rows.map((i) => i.type).sort()).toEqual(
      [
        'project.clone_retried',
        'project.converted_to_empty',
        'project.created',
        'project.deleted',
      ].sort(),
    );

    const deleted = rows.find((i) => i.type === 'project.deleted');
    // ⚠️ 名字**随事件走**：项目行已经没了，没有任何库可以回查（13 §2.8.2）。
    expect(deleted?.summary).toBe(`删除项目 ${name}`);
    // ⚠️ 否定断言：把 id 也拼进 summary 的写法在「包含项目名」下照样绿。
    expect(deleted?.summary).not.toContain(id);
    // id 仍然查得到 —— 它属于 subjectId 那一列（弱引用，不设 FK，正是为了这一刻）。
    expect(deleted?.subjectId).toBe(id);
  }, 60_000);

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
