import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { SandboxMcpTools } from '@platform/sandbox';
import { AppModule } from '../../src/app.module';

/**
 * Interface e2e (docs/backend/25 §6.1, shared/09 §2.3 gate 3): boots the whole
 * Nest app. Proves GET /api/health (passcode-exempt) and — crucially — that the
 * REST controller and the MCP tool provider drive the SAME application service.
 */
let app: INestApplication;

beforeAll(async () => {
  process.env.DATABASE_URL = ':memory:';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

describe('GET /api/health', () => {
  it('returns ok (passcode-exempt liveness)', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok' });
    expect(res.body.uptimeSec).toBeGreaterThanOrEqual(0);
  });
});

describe('REST + MCP dual-protocol shell over one application service', () => {
  it('a sandbox created via REST is visible through the MCP tool', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId: 'prj-e2e', runtime: 'claude-code' })
      .expect(201);
    expect(created.body).toMatchObject({ status: 'pending', projectId: 'prj-e2e' });

    // invoke the actual @Tool-decorated MCP handler resolved from the container
    const mcpTools = app.get(SandboxMcpTools);
    const toolResult = await mcpTools.listSandboxes({ projectId: 'prj-e2e' });
    expect(toolResult.content[0].type).toBe('text');
    const listed = JSON.parse(toolResult.content[0].text) as Array<{ id: string }>;
    expect(listed.map((s) => s.id)).toContain(created.body.id);
  });
});
