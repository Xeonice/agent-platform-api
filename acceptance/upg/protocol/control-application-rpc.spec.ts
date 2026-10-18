import { assertDefined } from '../../support/assert-defined';
import 'reflect-metadata';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { io } from 'socket.io-client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  SANDBOX_PROVIDER_REGISTRY,
  IMAGE_SPEC_REGISTRY,
  type ProviderRegistry,
  WS_TASKS_SCHEMA_HASH,
} from '@platform/contracts';
import { TasksGateway } from '@platform/sandbox';
import { EventsGateway } from '../../../apps/api/src/platform/events/events.gateway';
import { HelperContainerSession } from '@platform/runtime';
import type Database from 'better-sqlite3';
import { ProtocolProvider, registryMetadataFixture } from '../../support/protocol-resources';
import { useEnv } from '../../support/strict-ports';
import { configurePlatformApp } from '../../../apps/api/src/bootstrap/configure-app';
import { setupWebsockets } from '../../../apps/api/src/bootstrap/websocket.setup';
import { PLATFORM_SQLITE } from '../../../apps/api/src/platform/persistence/platform.module';
import { ApplicationOperationSchema } from '../../../apps/api/src/platform/control-rpc/control-rpc.contract';
import { UpgradeCatalog } from '../../../apps/api/src/platform/upgrade/upgrade-catalog';
import { UpgradeService } from '../../../apps/api/src/platform/upgrade/upgrade-service';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import { freezeUpgradeChain } from '../../../apps/api/src/platform/upgrade/upgrade-chain';
import { withCoordinatorBusinessEpoch } from '../../../apps/api/src/platform/persistence/coordinator-lease';
import { planFixtureEnvelope, planFixtureSource } from '../../support/upgrade-plan-fixture';
import type {
  ApplicationRequest,
  ApplicationCatalog,
} from '../../../apps/api/src/platform/control-rpc/control-rpc.contract';

const INSTANCE = 'control-rpc-test-instance';
const INTERNAL_KEY = 'synthetic-control-rpc-key-at-least-32-characters';
const PASSCODE = 'synthetic-control-rpc-access-passcode';
const ORIGIN = 'http://127.0.0.1:43191';
const roleEntry = resolve('apps/api/dist/roles/control-api-main.js');
let coordinator: {
  app: import('@nestjs/common').INestApplication;
  provider: ProtocolProvider;
  url: string;
};
let role: ChildProcessWithoutNullStreams;
let url = '';
let cookie = '';
let db: Database.Database;
let directory = '';
let restore: () => void = () => undefined;
function cookies(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((part): part is string => typeof part === 'string');
  return typeof value === 'string' ? [value] : [];
}
const internal = () => ({
  'x-platform-internal-key': INTERNAL_KEY,
  'x-platform-instance-id': INSTANCE,
});
const publicRead = (path: string) =>
  request(url).get(path).set('Origin', ORIGIN).set('Cookie', cookie);
const publicWrite = (path: string, operationId = randomUUID()) =>
  request(url)
    .post(path)
    .set('Origin', ORIGIN)
    .set('Cookie', cookie)
    .set('x-operation-id', operationId);
function original(
  operation: string,
  args: unknown[],
  operationId = randomUUID(),
): ApplicationRequest {
  return {
    operation,
    operationId,
    args,
    request: {
      method: 'POST',
      path: '/api/projects',
      headers: { cookie, origin: ORIGIN, host: new URL(url).host },
      query: {},
      remoteAddress: '198.51.100.19',
    },
  };
}
function startRole(coordinatorUrl: string): Promise<string> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PLATFORM_PROCESS_ROLE: 'control',
    PLATFORM_INSTANCE_ID: INSTANCE,
    PLATFORM_CONTROL_RPC_KEY: INTERNAL_KEY,
    COORDINATOR_RPC_URL: coordinatorUrl,
    PORT: '0',
    HOST: '127.0.0.1',
  };
  for (const key of [
    'DATABASE_URL',
    'DATA_ROOT',
    'BOXLITE_HOME',
    'RUNTIME_OWNER_HOME',
    'PLATFORM_COORDINATOR_RPC_KEY',
    'PLATFORM_CONTROLLER_RPC_KEY',
  ])
    delete childEnv[key];
  role = spawn(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(roleEntry)}).startControlApi().then(s=>console.log('CONTROL_READY:'+JSON.stringify(s.address()))).catch(e=>{console.error(e.message);process.exit(1)})`,
    ],
    { env: childEnv, stdio: 'pipe' },
  );
  return new Promise((ok, fail) => {
    let output = '';
    let errors = '';
    const timeout = setTimeout(
      () => fail(new Error(`Control API did not become ready: ${errors}`)),
      10_000,
    );
    role.stderr.on('data', (bytes) => {
      errors += String(bytes);
    });
    role.stdout.on('data', (bytes) => {
      output += String(bytes);
      const match = /CONTROL_READY:(\{[^\n]+\})/.exec(output);
      if (!match) return;
      const address: unknown = JSON.parse(assertDefined(match[1]));
      if (
        !address ||
        typeof address !== 'object' ||
        !('port' in address) ||
        typeof address.port !== 'number'
      )
        return;
      clearTimeout(timeout);
      ok(`http://127.0.0.1:${address.port}`);
    });
    role.once('exit', (code) => {
      clearTimeout(timeout);
      fail(new Error(`Control API exited ${code}: ${errors}`));
    });
    role.once('error', (error) => {
      clearTimeout(timeout);
      fail(error);
    });
  });
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'upg-real-control-rpc-'));
  restore = useEnv({
    DATABASE_URL: join(directory, 'fresh.sqlite'),
    DATA_ROOT: directory,
    PLATFORM_PROCESS_ROLE: 'coordinator',
    PLATFORM_INSTANCE_ID: INSTANCE,
    PLATFORM_CONTROL_RPC_KEY: INTERNAL_KEY,
    ACCESS_PASSCODE: PASSCODE,
    ACCESS_PASSCODE_ALLOW_LOOPBACK: 'false',
    ACCESS_PASSCODE_AUTO_GENERATE: 'false',
    API_ALLOWED_ORIGINS: ORIGIN,
    PASSCODE_COOKIE_SECURE: 'false',
    UPGRADE_ADMIN_KEY: undefined,
    SANDBOX_DEFAULT_IMAGE: 'ghcr.io/agent-infra/sandbox:latest',
  });
  const { AppModule } = await import('../../../apps/api/src/app.module');
  const provider = new ProtocolProvider();
  const providers: ProviderRegistry = {
    defaultProvider: provider.name,
    get: () => provider,
    has: (name) => name === provider.name,
    list: () => [provider],
    register: () => {
      throw new Error('Only the declared external provider fixture is available');
    },
  };
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SANDBOX_PROVIDER_REGISTRY)
    .useValue(providers)
    .overrideProvider(IMAGE_SPEC_REGISTRY)
    .useValue(registryMetadataFixture())
    .compile();
  const app = module.createNestApplication();
  configurePlatformApp(app);
  setupWebsockets(app);
  await app.init();
  await app.listen(0, '127.0.0.1');
  coordinator = { app, provider, url: await app.getUrl() };
  db = app.get(PLATFORM_SQLITE, { strict: false });
  await vi.waitFor(
    () =>
      expect(app.get(HelperContainerSession, { strict: false }).status()).toMatchObject({
        ready: true,
        starting: false,
      }),
    { timeout: 10_000 },
  );
  url = await startRole(coordinator.url);
  const unlock = await request(url)
    .post('/api/access/unlock')
    .set('Origin', ORIGIN)
    .send({ passcode: PASSCODE })
    .expect(200);
  const issued = cookies(unlock.headers['set-cookie']);
  expect(issued).toHaveLength(1);
  cookie = assertDefined(assertDefined(issued[0]).split(';')[0]);
});
afterAll(async () => {
  role?.kill('SIGTERM');
  if (coordinator) {
    await coordinator.app.close();
    coordinator.provider.close();
  }
  restore();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('UPG C/I · actual Coordinator usecases through an independent ControlAPI process', () => {
  it('actual private HTTP rejects wrong authority and advertises concrete controller/tool operations', async () => {
    await request(coordinator.url).get('/internal/application/catalog').expect(401);
    await request(coordinator.url)
      .get('/internal/application/catalog')
      .set({ ...internal(), 'x-platform-instance-id': 'other-instance' })
      .expect(401);
    const catalog = await request(coordinator.url)
      .get('/internal/application/catalog')
      .set(internal())
      .expect(200);
    const body = catalog.body as ApplicationCatalog;
    expect(body.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'ProjectController.create',
          path: '/api/projects',
          verb: 'POST',
        }),
      ]),
    );
    expect(body.tools.map((tool) => tool.name)).toContain('list_projects');
    await request(coordinator.url)
      .post('/internal/application/invoke')
      .set(internal())
      .send(original('arbitrary.shell.exec', []))
      .expect(400);
  });
  it('read-only public REST and actual ControlAPI identity never load a database/provider SDK or invoke the provider', async () => {
    const calls = [...coordinator.provider.calls];
    const commands = [...coordinator.provider.commands];
    await publicRead('/api/projects').expect(200);
    await publicRead('/api/system/resources').expect(200);
    const identity = await request(url)
      .get('/internal/control/identity')
      .set(internal())
      .expect(200);
    expect(identity.body).toMatchObject({
      instanceId: INSTANCE,
      role: 'control',
      controlOnly: true,
      noRuntimeSideEffects: true,
    });
    expect(identity.body.pid).not.toBe(process.pid);
    expect(coordinator.provider.calls).toEqual(calls);
    expect(coordinator.provider.commands).toEqual(commands);
  });
  it('preserves original authentication, Origin rejection, HttpOnly Set-Cookie and original DTO validation', async () => {
    await request(url).get('/api/projects').set('Origin', ORIGIN).expect(401);
    await request(url)
      .post('/api/projects')
      .set('Origin', 'https://foreign.example')
      .set('Cookie', cookie)
      .send({ name: 'foreign', sourceType: 'empty' })
      .expect(403);
    const invalid = await publicWrite('/api/projects')
      .send({ name: '', sourceType: 'empty' })
      .expect(400);
    expect(invalid.headers['content-type']).toContain('application/json');
    expect(invalid.body).toMatchObject({ code: 'VALIDATION_FAILED', sideEffectFree: true });
    const denied = db
      .prepare('SELECT count(*) AS n FROM projects WHERE name IN (?, ?)')
      .get('foreign', '') as { n: number };
    expect(denied.n).toBe(0);
  });
  it('the same accepted operation ID creates one real business row and conflicting input does not execute', async () => {
    const operation = randomUUID();
    const input = { name: `rpc-${randomUUID()}`, sourceType: 'empty' };
    const first = await publicWrite('/api/projects', operation).send(input).expect(202);
    const repeated = await publicWrite('/api/projects', operation).send(input).expect(202);
    expect(first.body.id).toBeTruthy();
    expect(repeated.body).toEqual(first.body);
    const row = db.prepare('SELECT count(*) AS n FROM projects WHERE name=?').get(input.name) as {
      n: number;
    };
    expect(row.n).toBe(1);
    const conflict = await publicWrite('/api/projects', operation)
      .send({ ...input, name: `${input.name}-different` })
      .expect(400);
    expect(conflict.body.code).toBe('OPERATION_ID_CONFLICT');
    expect(
      (
        db
          .prepare('SELECT count(*) AS n FROM projects WHERE name=?')
          .get(`${input.name}-different`) as { n: number }
      ).n,
    ).toBe(0);
  });
  it('an unknown original operation never replays business when queried/retried with the same identity', async () => {
    const operation = randomUUID();
    const input = { name: `unknown-${randomUUID().slice(0, 20)}`, sourceType: 'empty' };
    const payload = original('ProjectController.create', [input], operation);
    const digest = createHash('sha256')
      .update(JSON.stringify({ operation: payload.operation, args: payload.args }))
      .digest('hex');
    const actor = createHash('sha256').update(cookie).digest('hex');
    db.prepare("INSERT INTO application_operations VALUES(?,?,?,'unknown',NULL,?)").run(
      operation,
      actor,
      digest,
      Date.now(),
    );
    const before = [...coordinator.provider.calls];
    const result = await publicWrite('/api/projects', operation).send(input).expect(409);
    expect(result.body).toMatchObject({ code: 'OPERATION_RESULT_UNKNOWN', retryable: false });
    expect(
      (
        db.prepare('SELECT count(*) AS n FROM projects WHERE name=?').get(input.name) as {
          n: number;
        }
      ).n,
    ).toBe(0);
    expect(coordinator.provider.calls).toEqual(before);
  });
  it('looks up original pending/unknown/complete/absent operations read-only and isolates the actual public actor', async () => {
    const operation = randomUUID();
    const input = { name: `lookup-${randomUUID().slice(0, 20)}`, sourceType: 'empty' };
    const created = await publicWrite('/api/projects', operation).send(input).expect(202);
    const count = () =>
      (db.prepare('SELECT count(*) AS n FROM application_operations').get() as { n: number }).n;
    const before = count();
    const calls = [...coordinator.provider.calls];
    const read = await publicRead(`/api/operations/${operation}`).expect(200);
    const complete = ApplicationOperationSchema.parse(read.body);
    expect(complete).toMatchObject({
      operationId: operation,
      state: 'complete',
      resultAvailable: true,
      result: created.body,
    });
    const extraCookie = await request(url)
      .get(`/api/operations/${operation}`)
      .set('Origin', ORIGIN)
      .set('Cookie', `${cookie}; ap_upgrade_grant=unrelated-cookie`)
      .expect(200);
    expect(ApplicationOperationSchema.parse(extraCookie.body).state).toBe('complete');
    for (const state of ['pending', 'unknown'] as const) {
      const id = randomUUID();
      db.prepare('INSERT INTO application_operations VALUES(?,?,?,?,NULL,?)').run(
        id,
        createHash('sha256').update(cookie).digest('hex'),
        'fixture-original-persisted-digest',
        state,
        Date.now(),
      );
      const lookup = await publicRead(`/api/operations/${id}`).expect(200);
      expect(ApplicationOperationSchema.parse(lookup.body)).toMatchObject({
        operationId: id,
        state,
        resultAvailable: false,
      });
    }
    const absent = await publicRead(`/api/operations/${randomUUID()}`).expect(200);
    expect(ApplicationOperationSchema.parse(absent.body)).toMatchObject({
      state: 'absent',
      resultAvailable: false,
    });
    await request(url).get(`/api/operations/${operation}`).set('Origin', ORIGIN).expect(401);
    const another = await request(url)
      .post('/api/access/unlock')
      .set('Origin', ORIGIN)
      .send({ passcode: PASSCODE })
      .expect(200);
    const otherActor = assertDefined(
      assertDefined(cookies(another.headers['set-cookie'])[0]).split(';')[0],
    );
    expect(otherActor).not.toBe(cookie);
    await request(url)
      .get(`/api/operations/${operation}`)
      .set('Origin', ORIGIN)
      .set('Cookie', otherActor)
      .expect(401);
    expect(count()).toBe(before + 3); // only the 2 explicit fixture rows and the explicit unlock operation
    expect(coordinator.provider.calls).toEqual(calls);
    expect(
      (
        db.prepare('SELECT count(*) AS n FROM projects WHERE name=?').get(input.name) as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });
  it('a completed sensitive operation lookup exposes no secret response or input and does not rerun it', async () => {
    const operation = randomUUID();
    await publicWrite('/api/access/unlock', operation).send({ passcode: PASSCODE }).expect(200);
    const ledger = db
      .prepare('SELECT result FROM application_operations WHERE id=?')
      .get(operation) as { result: string | null };
    expect(ledger.result).toBeNull();
    const response = await publicRead(`/api/operations/${operation}`).expect(200);
    expect(ApplicationOperationSchema.parse(response.body)).toMatchObject({
      state: 'complete',
      resultAvailable: false,
    });
    expect(response.body).not.toHaveProperty('result');
    expect(JSON.stringify(response.body)).not.toContain(PASSCODE);
  });
  it('the existing unlock authorizes upgrades through actual ControlAPI RPC without a separate key', async () => {
    const before = (db.prepare('SELECT count(*) n FROM upgrade_attempts').get() as { n: number }).n;
    const status = await publicRead('/api/system/upgrade/status').expect(200);
    const viewerCookies = cookies(status.headers['set-cookie']);
    expect(viewerCookies.length).toBeGreaterThan(0);
    expect(viewerCookies[0]).toContain('HttpOnly');
    expect(status.headers['x-upgrade-user-scope']).toBe(status.body.userScope);
    expect(status.body.capabilities).toMatchObject({
      canUpgradeInstance: true,
      canAuthenticate: false,
    });
    expect((db.prepare('SELECT count(*) n FROM upgrade_attempts').get() as { n: number }).n).toBe(
      before,
    );
    const viewer = [...viewerCookies.map((value) => value.split(';')[0]), cookie].join('; ');
    // The old endpoint remains usable for rolling clients, without issuing a grant.
    await request(url)
      .post('/api/system/upgrade/access')
      .set('Origin', ORIGIN)
      .set('Cookie', viewer)
      .send({})
      .expect(403);
    const compatible = await request(url)
      .post('/api/system/upgrade/access')
      .set('Origin', ORIGIN)
      .set('Cookie', viewer)
      .set('x-upgrade-csrf', status.body.csrfToken)
      .send({})
      .expect(200);
    expect(compatible.body.capabilities).toMatchObject({
      canUpgradeInstance: true,
      canAuthenticate: false,
    });
    expect(
      cookies(compatible.headers['set-cookie']).some((value) =>
        value.startsWith('ap_upgrade_grant='),
      ),
    ).toBe(false);
    expect(compatible.body.userScope).toBe(status.body.userScope);
    // A real upgrade command reaches catalog admission immediately; no manufactured installed release exists in this fixture.
    const command = {
      requestId: randomUUID(),
      targetReleaseId: 'v9.9.9-unpublished',
      targetDigest: 'sha256:' + 'a'.repeat(64),
      expectedActivationGeneration: 0,
    };
    for (const headers of [
      { Origin: ORIGIN, Cookie: viewer },
      { Origin: 'https://other.invalid', Cookie: viewer, 'x-upgrade-csrf': status.body.csrfToken },
    ])
      await request(url)
        .post('/api/system/upgrade/requests')
        .set(headers)
        .send(command)
        .expect(403);
    await request(url)
      .post('/api/system/upgrade/requests')
      .set('Origin', ORIGIN)
      .set('Cookie', 'ap_session=forged; ap_upgrade_grant=forged')
      .set('x-upgrade-csrf', status.body.csrfToken)
      .send(command)
      .expect(401);
    const reached = await request(url)
      .post('/api/system/upgrade/requests')
      .set('Origin', ORIGIN)
      .set('Cookie', viewer)
      .set('x-upgrade-csrf', status.body.csrfToken)
      .send(command)
      .expect(409);
    expect(reached.body.code).not.toBe('UPGRADE_PERMISSION_REQUIRED');
    expect((db.prepare('SELECT count(*) n FROM upgrade_attempts').get() as { n: number }).n).toBe(
      before,
    );
    // Lookup uses real actor scope and exposes the viewer proof header through both process/RPC hops.
    const id = randomUUID();
    // A missing request still exercises authorization but deliberately fabricates no accepted release.
    const missing = await publicRead('/api/system/upgrade/requests/' + id).expect(404);
    expect(missing.body.code).toBe('UPGRADE_REQUEST_NOT_FOUND');
  });
  it('forwards the actual audit gzip bytes and headers rather than a JSON representation of a stream', async () => {
    const binary = await fetch(`${url}/api/system/audit/export`, {
      headers: { Origin: ORIGIN, Cookie: cookie },
    });
    expect(binary.status).toBe(200);
    expect(binary.headers.get('content-type')).toContain('application/gzip');
    expect(binary.headers.get('content-disposition')).toContain('attachment; filename=');
    const bytes = Buffer.from(await binary.arrayBuffer());
    expect([...bytes.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    const tar = gunzipSync(bytes);
    expect(tar.includes(Buffer.from('audit.jsonl'))).toBe(true);
    expect(tar.includes(Buffer.from('export-range.json'))).toBe(true);
  });
  it('preserves a genuine POST diagnostics SSE stream and its schema/cache headers', async () => {
    const response = await fetch(`${url}/api/system/diagnose`, {
      method: 'POST',
      headers: { Origin: ORIGIN, Cookie: cookie },
      signal: AbortSignal.timeout(20_000),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.headers.get('x-schema-hash')).toBeTruthy();
    const body = await response.text();
    expect(body).toContain('event: start');
    expect(body).toContain('event: check');
    expect(body).toContain('event: done');
    expect(body).not.toContain('application/x-ndjson');
  });
  it('MCP initialization and tools listing require the current public access cookie', async () => {
    const denied = await request(url)
      .post('/mcp')
      .set('Origin', ORIGIN)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'unlocked-not-present', version: '1.0.0' },
        },
      });
    expect(denied.status).toBe(401);
    const client = new Client({ name: 'current-cookie-required', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Origin: ORIGIN, Cookie: cookie } },
    });
    try {
      await client.connect(transport);
      const leaked = await request(url)
        .post('/mcp')
        .set('Origin', ORIGIN)
        .set('Accept', 'application/json, text/event-stream')
        .set('mcp-session-id', transport.sessionId ?? '')
        .set('mcp-protocol-version', '2025-03-26')
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      expect(leaked.status).toBe(401);
    } finally {
      await client.close();
    }
  });
  it('an authenticated MCP session ID cannot lend its original cookie to a later unauthenticated mutation', async () => {
    const client = new Client({ name: 'session-identity-scope', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Origin: ORIGIN, Cookie: cookie } },
    });
    const name = `stolen-${randomUUID().slice(0, 20)}`;
    try {
      await client.connect(transport);
      const stolen = await request(url)
        .post('/mcp')
        .set('Origin', ORIGIN)
        .set('Accept', 'application/json, text/event-stream')
        .set('mcp-session-id', transport.sessionId ?? '')
        .set('mcp-protocol-version', '2025-03-26')
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'create_project', arguments: { name, sourceType: 'empty' } },
        });
      expect(stolen.status).toBe(401);
      expect(
        (db.prepare('SELECT count(*) AS n FROM projects WHERE name=?').get(name) as { n: number })
          .n,
      ).toBe(0);
    } finally {
      await client.close();
    }
  });
  it('actual WebSocket namespaces reject a missing public cookie before reaching external resources', async () => {
    const calls = [...coordinator.provider.calls];
    const commands = [...coordinator.provider.commands];
    for (const namespace of ['/events', '/terminal', '/tasks']) {
      const socket = io(`${url}${namespace}`, {
        transports: ['websocket'],
        reconnection: false,
        timeout: 2000,
        query: {
          sandboxId: 'not-created',
          xSchemaHash: namespace === '/tasks' ? 'sb-tasks-v1' : 'sb-terminal-v4',
        },
        extraHeaders: { Origin: ORIGIN },
      });
      try {
        const connected = await new Promise<boolean>((resolve) => {
          socket.once('connect', () => resolve(true));
          socket.once('connect_error', () => resolve(false));
        });
        expect(connected).toBe(false);
      } finally {
        socket.disconnect();
      }
    }
    expect(coordinator.provider.calls).toEqual(calls);
    expect(coordinator.provider.commands).toEqual(commands);
  });
  it('actual MCP tools use the same application graph and WebSocket authentication still reaches the Coordinator gateway', async () => {
    const client = new Client({ name: 'control-rpc-real-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Origin: ORIGIN, Cookie: cookie } },
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('list_projects');
      const result = await client.callTool({ name: 'list_projects', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'text' })]),
      );
    } finally {
      await client.close();
    }
    const socket = io(`${url}/events`, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 2000,
      extraHeaders: { Origin: ORIGIN, Cookie: cookie },
    });
    try {
      const connected = await new Promise<boolean>((resolve) => {
        socket.once('connect', () => resolve(true));
        socket.once('connect_error', () => resolve(false));
      });
      expect(connected).toBe(true);
    } finally {
      socket.disconnect();
    }
  });
  for (const namespace of ['/events', '/tasks'] as const) {
    it(`actual ${namespace} handoff closes only transport, refuses stale admission and resumes authenticated access`, async () => {
      const gateway =
        namespace === '/events'
          ? coordinator.app.get(EventsGateway)
          : coordinator.app.get(TasksGateway);
      const calls = [...coordinator.provider.calls],
        commands = [...coordinator.provider.commands];
      const sockets: ReturnType<typeof io>[] = [];
      const connect = (): Promise<ReturnType<typeof io>> =>
        new Promise((ok, fail) => {
          const socket = io(`${url}${namespace}`, {
            transports: ['websocket'],
            reconnection: false,
            forceNew: true,
            timeout: 2000,
            query: { sandboxId: 'transport-only-no-task', xSchemaHash: WS_TASKS_SCHEMA_HASH },
            extraHeaders: { Origin: ORIGIN, Cookie: cookie },
          });
          sockets.push(socket);
          socket.once('connect', () => ok(socket));
          socket.once('connect_error', fail);
        });
      try {
        const originalSocket = await connect();
        const originalId = originalSocket.id;
        await vi.waitFor(() => expect(gateway.activeTransportConnections).toBe(1));
        const detached = new Promise<void>((ok) => originalSocket.once('disconnect', () => ok()));
        expect(gateway.prepareHandoff()).toBe(1);
        await detached;
        await vi.waitFor(() => expect(gateway.activeTransportConnections).toBe(0));
        await expect(connect()).rejects.toMatchObject({
          data: { code: 'APPLICATION_WRITER_QUIESCED' },
        });
        gateway.resumeAfterHandoff();
        const restored = await connect();
        expect(restored.id).not.toBe(originalId);
        expect(restored.connected).toBe(true);
        expect(coordinator.provider.calls).toEqual(calls);
        expect(coordinator.provider.commands).toEqual(commands);
      } finally {
        gateway.resumeAfterHandoff();
        for (const socket of sockets) socket.disconnect();
      }
    });
  }
  it('preserves Prefer and negotiated operation responses through the real independent Control API', async () => {
    const store = coordinator.app.get(UpgradeStore),
      service = coordinator.app.get(UpgradeService),
      catalog = coordinator.app.get(UpgradeCatalog);
    // The installation/catalog boundary is synthetic; transport, ordinary
    // authentication/CSRF and the durable operation ledger are actual production
    // code. Park the executor so this transport test never prepares an install.
    const advance = vi.spyOn(service, 'advanceOperation').mockResolvedValue(undefined);
    const source = planFixtureSource();
    withCoordinatorBusinessEpoch(db, () => store.bootstrap(source));
    const envelope = planFixtureEnvelope(source, '0.2.1');
    const chain = freezeUpgradeChain(envelope, source, [envelope]);
    const target = vi.spyOn(catalog, 'target').mockReturnValue({
      envelope,
      plan: assertDefined(chain[0]).plan,
      sourceActual: null,
      chain,
    });
    try {
      const status = await publicRead('/api/system/upgrade/status').expect(200);
      const viewer = [
        cookie,
        ...cookies(status.headers['set-cookie']).map((c) => c.split(';')[0]),
      ].join('; ');
      const command = {
        requestId: randomUUID(),
        targetReleaseId: envelope.manifest.releaseId,
        targetDigest: envelope.manifestDigest,
        expectedActivationGeneration: source.activationGeneration,
      };
      const accepted = await publicWrite('/api/system/upgrade/requests')
        .set('Cookie', viewer)
        .set('X-Upgrade-CSRF', status.body.csrfToken)
        .set('Prefer', 'respond-async')
        .send(command)
        .expect(202);
      expect(accepted.body).toMatchObject({
        requestId: command.requestId,
        finalTargetDigest: command.targetDigest,
        state: 'accepted',
        sequence: 0,
        stages: [expect.objectContaining({ attemptId: null, state: 'pending' })],
      });
      expect(accepted.body).not.toHaveProperty('attemptId');
      expect(accepted.headers.vary).toContain('Prefer');
      expect(accepted.headers['preference-applied']).toBe('respond-async');
      expect(accepted.headers['cache-control']).toBe('no-store');
      const recovered = await request(url)
        .get('/api/system/upgrade/requests/' + command.requestId)
        .set('Cookie', viewer)
        .set('Prefer', 'respond-async')
        .expect(200);
      expect(recovered.body.operationId).toBe(accepted.body.operationId);
      expect(recovered.headers.vary).toContain('Prefer');
      expect(recovered.headers['cache-control']).toBe('no-store');
      const legacy = await request(url)
        .get('/api/system/upgrade/requests/' + command.requestId)
        .set('Cookie', viewer)
        .expect(409);
      expect(legacy.body.code).toBe('UPGRADE_OPERATION_REQUIRES_ASYNC');
      expect((db.prepare('SELECT count(*) n FROM upgrade_attempts').get() as { n: number }).n).toBe(
        0,
      );
    } finally {
      target.mockRestore();
      advance.mockRestore();
    }
  });
});
