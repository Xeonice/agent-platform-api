import { createServer, type Server } from 'node:http';
import { readdir, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { asProjectId } from '@platform/shared-kernel';
import { createPlatform } from '../../support/platform-app';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../packages/modules/project/src/domain/repositories/project.repository';
let platform: Awaited<ReturnType<typeof createPlatform>>;
const servers: Server[] = [];
beforeAll(async () => {
  platform = await createPlatform();
});
afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  await platform.close();
});
const http = () => request(platform.app.getHttpServer());
async function missingRemote() {
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end('Repository not found');
  });
  servers.push(server);
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
  if (lan === undefined)
    throw new Error('A real non-loopback interface is required by the clone SSRF policy');
  await new Promise<void>((done) => server.listen(0, lan, done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local Git fixture address');
  return { server, repoUrl: `http://${address.address}:${address.port}/owner/repo.git` };
}
async function failedProject(name: string) {
  const remote = await missingRemote();
  const response = await http()
    .post('/api/projects')
    .send({ name, sourceType: 'git', repoUrl: remote.repoUrl })
    .expect(202);
  await vi.waitFor(async () =>
    expect(
      (await http().get(`/api/projects/${response.body.id}`).expect(200)).body.cloneStatus,
    ).toBe('failed'),
  );
  return {
    ...remote,
    project: (await http().get(`/api/projects/${response.body.id}`).expect(200)).body,
  };
}
describe('PRJ real HTTP, Git subprocess, current SQLite and baseline filesystem', () => {
  it('MCP advertises the Unicode name limit and enforces it while preserving the same project record as REST', async () => {
    const client = new Client(
      { name: 'project-name-acceptance', version: '1' },
      { capabilities: {} },
    );
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${platform.url}/api/mcp`)));
      const tools = (await client.listTools()).tools;
      const create = tools.find((tool) => tool.name === 'create_project');
      expect(create?.inputSchema.properties?.name).toMatchObject({
        type: 'string',
        minLength: 1,
        maxLength: 40,
      });
      expect(
        tools.find((tool) => tool.name === 'create_sandbox')?.inputSchema.properties?.projectId,
      ).toMatchObject({ type: 'string', minLength: 1 });
      const name = '🚀'.repeat(40);
      const created = await client.callTool({
        name: 'create_project',
        arguments: { name, sourceType: 'empty' },
      });
      expect(created.isError).not.toBe(true);
      const content = created.content as { type: string; text: string }[];
      const dto = JSON.parse(content[0].text) as { id: string; name: string };
      expect(dto.name).toBe(name);
      expect((await http().get(`/api/projects/${dto.id}`).expect(200)).body.name).toBe(name);
      const repository = platform.app.get<ProjectRepository>(PROJECT_REPOSITORY);
      expect((await repository.findById(asProjectId(dto.id)))?.name).toBe(name);
      const before = (await http().get('/api/projects').expect(200)).body.length;
      const rejected = await client.callTool({
        name: 'create_project',
        arguments: { name: `${name}😀`, sourceType: 'empty' },
      });
      expect(rejected.isError).toBe(true);
      expect((rejected.content as { text: string }[])[0].text).toContain('项目名称最多 40 个字符');
      expect((await http().get('/api/projects').expect(200)).body).toHaveLength(before);
    } finally {
      await client.close();
    }
  });
  it('PRJ-002 accepts and persists 40 Unicode code points while the 41st is rejected before project creation', async () => {
    const name = '😀'.repeat(40);
    const created = await http()
      .post('/api/projects')
      .send({ name, sourceType: 'empty' })
      .expect(202);
    expect(created.body.name).toBe(name);
    const repository = platform.app.get<ProjectRepository>(PROJECT_REPOSITORY);
    expect((await repository.findById(asProjectId(created.body.id)))?.name).toBe(name);
    const before = (await http().get('/api/projects').expect(200)).body.length;
    const rejected = await http()
      .post('/api/projects')
      .send({ name: `${name}😀`, sourceType: 'empty' })
      .expect(400);
    expect(rejected.body.code).toBe('VALIDATION_FAILED');
    expect((await http().get('/api/projects').expect(200)).body).toHaveLength(before);
  });
  it('creates an actual empty directory immediately; completed cancellation is read-only and ready conversion/sync are refused', async () => {
    const created = await http()
      .post('/api/projects')
      .send({ name: 'empty lifecycle', sourceType: 'empty' })
      .expect(202);
    expect(created.body).toMatchObject({ sourceType: 'empty', cloneStatus: 'ready', taskCount: 0 });
    const actual = await platform.app
      .get<ProjectRepository>(PROJECT_REPOSITORY)
      .findById(asProjectId(created.body.id));
    expect(actual).not.toBeNull();
    expect((await stat(actual!.baselinePath)).isDirectory()).toBe(true);
    expect(await readdir(actual!.baselinePath)).toEqual([]);
    const count = (await http().get('/api/system/audit?category=project').expect(200)).body.items
      .length;
    const cancelled = await http()
      .post(`/api/projects/${created.body.id}/cancel-clone`)
      .expect(200);
    expect(cancelled.body.cloneStatus).toBe('ready');
    expect(
      (await http().get('/api/system/audit?category=project').expect(200)).body.items.length,
    ).toBe(count);
    const conversion = await http()
      .post(`/api/projects/${created.body.id}/convert-to-empty`)
      .expect(409);
    expect(conversion.body.code).toBe('INVALID_STATE');
    const sync = await http().post(`/api/projects/${created.body.id}/sync`).expect(409);
    expect(sync.body.code).toBe('INVALID_STATE');
  });
  it('retries the same real repository and replaces the previous failure rather than making a second project', async () => {
    const failed = await failedProject('retry actual git');
    expect(failed.project.cloneErrorCode).toBe('CLONE_FAILED_NOT_FOUND');
    await new Promise<void>((done) => failed.server.close(() => done()));
    const before = (await http().get('/api/projects').expect(200)).body.length;
    const retry = await http().post(`/api/projects/${failed.project.id}/retry-clone`).expect(202);
    expect(retry.body.id).toBe(failed.project.id);
    await vi.waitFor(async () =>
      expect(
        (await http().get(`/api/projects/${failed.project.id}`).expect(200)).body.cloneStatus,
      ).toBe('failed'),
    );
    expect(
      (await http().get(`/api/projects/${failed.project.id}`).expect(200)).body.cloneErrorCode,
    ).toBe('CLONE_FAILED_NETWORK');
    expect((await http().get('/api/projects').expect(200)).body).toHaveLength(before);
  });
  it('failed-project admission performs no provider work; conversion preserves identity and creates an empty baseline', async () => {
    const failed = await failedProject('convert actual git');
    const sync = await http().post(`/api/projects/${failed.project.id}/sync`).expect(409);
    expect(sync.body.code).toBe('INVALID_STATE');
    const before = platform.provider.calls.length;
    const reject = await http()
      .post('/api/sandboxes')
      .send({ projectId: failed.project.id, runtime: 'codex' })
      .expect(409);
    expect(reject.body).toMatchObject({ code: 'PROJECT_NOT_READY', sideEffectFree: true });
    expect(
      (await http().get(`/api/sandboxes?projectId=${failed.project.id}`).expect(200)).body,
    ).toEqual([]);
    expect(platform.provider.calls.length).toBe(before);
    const result = await http()
      .post(`/api/projects/${failed.project.id}/convert-to-empty`)
      .expect(200);
    expect(result.body).toMatchObject({
      id: failed.project.id,
      name: failed.project.name,
      createdAt: failed.project.createdAt,
      sourceType: 'empty',
      cloneStatus: 'ready',
    });
    expect(result.body.repoUrl).toBeUndefined();
    expect(result.body.repoBranch).toBeUndefined();
    const actual = await platform.app
      .get<ProjectRepository>(PROJECT_REPOSITORY)
      .findById(asProjectId(failed.project.id));
    expect(await readdir(actual!.baselinePath)).toEqual([]);
  });
});
