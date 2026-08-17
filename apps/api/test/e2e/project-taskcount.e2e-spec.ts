import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { SANDBOX_PROVIDER_REGISTRY, WORKSPACE_PREPARER, PROJECT_FACADE } from '@platform/contracts';
import { AppModule } from '../../src/app.module';
import { fakeProjectFacade, fakeWorkspace, makeFakeRegistry } from './_fakes';

/**
 * ProjectDto.taskCount aggregation (shared/10 §7): GET /api/projects[/:id] reports
 * the number of LIVE Tasks (= sandboxes, 23 D-1) per project, resolved via the
 * cross-context SandboxFacade (project never imports the sandbox domain). Uses the
 * in-memory sandbox provider (no docker) so sandboxes are created/destroyed fast.
 */
let app: INestApplication;
let dataRoot: string;

beforeAll(async () => {
  process.env.DATABASE_URL = ':memory:';
  dataRoot = mkdtempSync(resolve(process.cwd(), 'tmp-taskcount-e2e-'));
  process.env.DATA_ROOT = dataRoot;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SANDBOX_PROVIDER_REGISTRY)
    .useValue(makeFakeRegistry())
    .overrideProvider(WORKSPACE_PREPARER)
    .useValue(fakeWorkspace)
    .overrideProvider(PROJECT_FACADE)
    .useValue(fakeProjectFacade)
    .compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
});

afterAll(async () => {
  await app?.close();
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
});

describe('ProjectDto.taskCount', () => {
  it('GET project/list reflect the live-sandbox count per project', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'counted', sourceType: 'empty' })
      .expect(202);
    const projectId = created.body.id as string;
    expect(created.body.taskCount).toBe(0);

    // create 3 sandboxes under the project
    const sandboxIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await request(app.getHttpServer())
        .post('/api/sandboxes')
        .send({ projectId, runtime: 'claude-code' })
        .expect(201);
      sandboxIds.push(s.body.id as string);
    }

    const got = await request(app.getHttpServer()).get(`/api/projects/${projectId}`).expect(200);
    expect(got.body.taskCount).toBe(3);

    const list = await request(app.getHttpServer()).get('/api/projects').expect(200);
    const entry = (list.body as Array<{ id: string; taskCount: number }>).find(
      (p) => p.id === projectId,
    );
    expect(entry?.taskCount).toBe(3);

    // destroying a sandbox drops the count (destroyed sandboxes are not live).
    // wait until it is running so destroy walks a legal transition path.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const s = await request(app.getHttpServer()).get(`/api/sandboxes/${sandboxIds[0]}`);
      if (s.body?.status === 'running') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await request(app.getHttpServer()).delete(`/api/sandboxes/${sandboxIds[0]}`).send({}).expect(204);
    const after = await request(app.getHttpServer()).get(`/api/projects/${projectId}`).expect(200);
    expect(after.body.taskCount).toBe(2);
  });
});
