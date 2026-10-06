import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SandboxDtoSchema, WS_SCHEMA_HASH } from '@platform/contracts';
import type { TerminalServerFrame } from '@platform/contracts';
import { createPlatform } from '../../support/platform-app';

let platform: Awaited<ReturnType<typeof createPlatform>>;
beforeAll(async () => {
  platform = await createPlatform();
});
afterAll(async () => {
  await platform?.close();
});
const http = () => request(platform.app.getHttpServer());
async function project(name: string) {
  const response = await http()
    .post('/api/projects')
    .send({ name, sourceType: 'empty' })
    .expect(202);
  expect(response.body.cloneStatus).toBe('ready');
  return String(response.body.id);
}
async function task(projectId: string) {
  const response = await http()
    .post('/api/sandboxes')
    .send({ projectId, runtime: 'claude-code' })
    .expect(201);
  const id = String(response.body.id);
  await vi.waitFor(
    async () =>
      expect((await http().get(`/api/sandboxes/${id}`).expect(200)).body.status).toBe('running'),
    { timeout: 5000 },
  );
  return id;
}

describe('complete Nest task lifecycle and shared transports', () => {
  it('cold bootstrap seeds selectable images without a test registration step', async () => {
    const images = await http().get('/api/images').expect(200);
    expect(images.body.length).toBeGreaterThan(0);
    const id = await task(await project('cold boot'));
    const dto = (await http().get(`/api/sandboxes/${id}`).expect(200)).body;
    expect(SandboxDtoSchema.safeParse(dto).success).toBe(true);
    expect(dto).toMatchObject({ hasRun: true, status: 'running' });
    expect(dto.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    await http().delete(`/api/sandboxes/${id}`).send({ keepVolume: false }).expect(204);
  });
  it('stop/start preserves task identity and first-run history; delete removes it from list and detail', async () => {
    const projectId = await project('lifecycle');
    const id = await task(projectId);
    const initial = (await http().get(`/api/sandboxes/${id}`).expect(200)).body;
    await http().post(`/api/sandboxes/${id}/stop`).expect(200);
    expect((await http().get(`/api/sandboxes/${id}`).expect(200)).body).toMatchObject({
      status: 'stopped',
      hasRun: true,
    });
    await http().post(`/api/sandboxes/${id}/start`).expect(200);
    await vi.waitFor(async () =>
      expect((await http().get(`/api/sandboxes/${id}`).expect(200)).body.status).toBe('running'),
    );
    expect((await http().get(`/api/sandboxes/${id}`).expect(200)).body).toMatchObject({
      id,
      imageId: initial.imageId,
      createdAt: initial.createdAt,
      hasRun: true,
    });
    await http().delete(`/api/sandboxes/${id}`).send({ keepVolume: false }).expect(204);
    const missing = await http().get(`/api/sandboxes/${id}`).expect(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND', retryable: false });
    expect((await http().get(`/api/sandboxes?projectId=${projectId}`).expect(200)).body).toEqual(
      [],
    );
    await http().delete(`/api/projects/${projectId}`).send({}).expect(204);
  });
  it('project and runtime door refusals return public envelopes without creating provider resources', async () => {
    const calls = platform.provider.calls.length;
    const missing = await http()
      .post('/api/sandboxes')
      .send({ projectId: 'missing', runtime: 'claude-code' })
      .expect(404);
    expect(missing.body).toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      sideEffectFree: true,
      retryable: false,
    });
    const unknown = await http()
      .post('/api/sandboxes')
      .send({ projectId: await project('unknown runtime'), runtime: 'unregistered-agent' })
      .expect(400);
    expect(unknown.body).toMatchObject({ code: 'UNKNOWN_RUNTIME', sideEffectFree: true });
    expect(platform.provider.calls.length).toBe(calls);
  });
  it('real MCP HTTP discovery and tools use the same task records as REST', async () => {
    const client = new Client({ name: 'acceptance', version: '1' }, { capabilities: {} });
    let stage = 'connect';
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${platform.url}/api/mcp`)));
      stage = 'listTools';
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('create_sandbox');
      const projectId = await project('mcp');
      stage = 'create_sandbox';
      const created = await client.callTool({
        name: 'create_sandbox',
        arguments: { projectId, runtime: 'claude-code' },
      });
      const content = created.content as { type: string; text?: string }[];
      const dto = SandboxDtoSchema.parse(JSON.parse(content[0].text!));
      const list = await client.callTool({ name: 'list_sandboxes', arguments: { projectId } });
      expect(
        JSON.parse((list.content as { text: string }[])[0].text).map(
          (row: { id: string }) => row.id,
        ),
      ).toEqual([dto.id]);
      expect((await http().get(`/api/sandboxes/${dto.id}`).expect(200)).body.id).toBe(dto.id);
      await http()
        .delete(`/api/sandboxes/${dto.id}`)
        .send({ force: true, keepVolume: false })
        .expect(204);
    } catch (error) {
      throw new Error(`MCP stage ${stage}: ${String(error)}`);
    } finally {
      await client.close();
    }
  });
  it('real terminal WS forwards native child bytes and input; disconnect detaches without sending a kill', async () => {
    const id = await task(await project('terminal'));
    const frames: TerminalServerFrame[] = [];
    const socket: Socket = io(`${platform.url}/terminal`, {
      transports: ['websocket'],
      reconnection: false,
      auth: { xSchemaHash: WS_SCHEMA_HASH },
      query: { sandboxId: id },
    });
    try {
      socket.on('frame', (frame: TerminalServerFrame) => frames.push(frame));
      await vi.waitFor(() =>
        expect(frames.some((frame) => frame.type === 'data' && frame.data.includes('❯'))).toBe(
          true,
        ),
      );
      socket.emit('frame', { type: 'input', data: 'acceptance-input\n' });
      await vi.waitFor(() =>
        expect(
          frames.some(
            (frame) => frame.type === 'data' && frame.data.includes('accepted:acceptance-input'),
          ),
        ).toBe(true),
      );
      const native = platform.provider.streams.at(-1)!;
      socket.disconnect();
      await vi.waitFor(() => expect(native.detached).toBe(true));
      expect(native.killed).toBe(false);
    } finally {
      socket.disconnect();
      await http()
        .delete(`/api/sandboxes/${id}`)
        .send({ force: true, keepVolume: false })
        .expect(204);
    }
  });
});
