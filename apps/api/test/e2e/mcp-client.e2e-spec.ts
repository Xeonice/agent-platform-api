import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SandboxApplicationService } from '@platform/sandbox';
import { AppModule } from '../../src/app.module';

/**
 * MCP client smoke (docs/backend/25 §6.1): a REAL MCP Client drives a tool over a
 * transport, and the tool handler delegates to the SAME SandboxApplicationService
 * the REST layer uses (resolved from the booted Nest container). This exercises
 * the MCP protocol path end-to-end via the SDK's low-level Server/Client API.
 */
let app: INestApplication;

beforeAll(async () => {
  process.env.DATABASE_URL = ':memory:';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

describe('MCP client can call a tool backed by the shared application service', () => {
  it('create_sandbox then list_sandboxes over an MCP transport', async () => {
    const appService = app.get(SandboxApplicationService);

    const server = new Server(
      { name: 'agent-platform-mcp-test', version: '0.0.1' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_sandboxes',
          description: 'List sandboxes by project',
          inputSchema: {
            type: 'object',
            properties: { projectId: { type: 'string' } },
          },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const projectId = (req.params.arguments as { projectId?: string } | undefined)?.projectId;
      const dtos = await appService.list(projectId);
      return { content: [{ type: 'text', text: JSON.stringify(dtos) }] };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // seed one sandbox through the shared application service
    const created = await appService.create({ projectId: 'prj-mcp', runtime: 'codex' });

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('list_sandboxes');

    const result = (await client.callTool({
      name: 'list_sandboxes',
      arguments: { projectId: 'prj-mcp' },
    })) as { content: Array<{ type: string; text: string }> };

    const listed = JSON.parse(result.content[0].text) as Array<{ id: string }>;
    expect(listed.map((s) => s.id)).toContain(created.id);

    await client.close();
    await server.close();
  });
});
