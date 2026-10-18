import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import 'reflect-metadata';
import express, { type Request, type Response } from 'express';
import { request as httpRequest, createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { connect } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { UuidIdGenerator } from '../platform/time/uuid-id-generator';
import { createLegacyMcpServer, createLegacySseTransport } from './types/shims/mcp-legacy';
import { z } from 'zod';
import { isRecord } from '@platform/shared-kernel';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  CallToolResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type ApplicationCatalog,
  type ApplicationRequest,
  ApplicationFrameSchema,
  ApplicationCatalogSchema,
} from '../platform/control-rpc/control-rpc.contract';
import { readPublicNetworkConfig } from '../platform/config/public-network';
import { isRequestOriginAllowed } from '../bootstrap/public-origin-policy';
import { createCoordinatorResolver } from '../platform/control-rpc/coordinator-routing';
import { SystemClock } from '../platform/time/system-clock';
import { installedApiIdentity } from '../platform/artifact-identity';
import { UPGRADE_PROBE_IDENTITY_HEADERS } from '../platform/upgrade/upgrade-probe-identity';

/** Public transport role: no database connection, migration, scheduler or SDK import. */
export async function startControlApi(): Promise<ReturnType<typeof createServer>> {
  process.env.PLATFORM_PROCESS_ROLE = 'control';
  const ids = new UuidIdGenerator();
  const clock = new SystemClock();
  function coordinatorDeadline(response: Response): number | undefined {
    const deadline: unknown = response.locals.coordinatorResolutionDeadline;
    return typeof deadline === 'number' ? deadline : undefined;
  }

  const installedArtifact = await installedApiIdentity('api');
  const instanceId = process.env.PLATFORM_INSTANCE_ID,
    key = process.env.PLATFORM_CONTROL_RPC_KEY;
  if (!instanceId || !key || key.length < 32) throw new Error('CONTROL_ROLE_CONFIG_REQUIRED');
  for (const forbidden of [
    'DATABASE_URL',
    'DATA_ROOT',
    'BOXLITE_HOME',
    'RUNTIME_OWNER_HOME',
    'PLATFORM_COORDINATOR_RPC_KEY',
    'PLATFORM_CONTROLLER_RPC_KEY',
  ])
    if (process.env[forbidden]) throw new Error('CONTROL_ROLE_HAS_FORBIDDEN_AUTHORITY');
  const coordinator = new URL(process.env.COORDINATOR_RPC_URL ?? '');
  if (
    coordinator.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(coordinator.hostname) ||
    coordinator.username ||
    coordinator.password ||
    coordinator.pathname !== '/' ||
    coordinator.search ||
    coordinator.hash
  )
    throw new Error('CONTROL_COORDINATOR_ORIGIN_REQUIRED');
  const internalHeaders = { 'x-platform-internal-key': key, 'x-platform-instance-id': instanceId };
  const coordinatorTarget = createCoordinatorResolver(coordinator, instanceId);
  const initialTarget = await coordinatorTarget();
  const catalogResponse = await fetch(initialTarget.origin + '/internal/application/catalog', {
    headers: internalHeaders,
    signal: AbortSignal.timeout(2000),
  });
  if (!catalogResponse.ok) throw new Error('APPLICATION_CATALOG_NOT_READY');
  let catalog = ApplicationCatalogSchema.parse(await catalogResponse.json());
  let catalogOrigin = initialTarget.origin;
  if (!catalog.routes.length || catalog.protocol.min > 2 || catalog.protocol.max < 1)
    throw new Error('APPLICATION_PROTOCOL_INCOMPATIBLE');
  const app = express();
  const ownProbeHeaders: Record<string, string> = {};
  const protectedProbeHeaders = new Set<string>(Object.values(UPGRADE_PROBE_IDENTITY_HEADERS));
  if (installedArtifact && process.env.PLATFORM_PROCESS_START_IDENTITY) {
    ownProbeHeaders[UPGRADE_PROBE_IDENTITY_HEADERS.instanceId] = instanceId;
    ownProbeHeaders[UPGRADE_PROBE_IDENTITY_HEADERS.artifactDigest] =
      installedArtifact.artifactDigest;
    ownProbeHeaders[UPGRADE_PROBE_IDENTITY_HEADERS.startIdentity] =
      process.env.PLATFORM_PROCESS_START_IDENTITY;
  }
  app.use((req, res, next) => {
    if (req.path === '/api/system/upgrade/probe')
      for (const [name, value] of Object.entries(ownProbeHeaders)) res.setHeader(name, value);
    next();
  });
  app.use((_req, res, next) => {
    res.locals.coordinatorResolutionDeadline = clock.now().getTime() + 1900;
    next();
  });
  app.disable('x-powered-by');
  app.use(express.json({ limit: '24mb' }));
  const network = readPublicNetworkConfig();
  app.use((req, res, next) => {
    if (
      !isRequestOriginAllowed(req, network) ||
      (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        req.headers.origin === undefined &&
        req.headers['sec-fetch-site'] !== undefined)
    ) {
      res.status(403).json({
        code: 'FORBIDDEN',
        message: '请求来源不在允许列表中',
        retryable: false,
        sideEffectFree: true,
      });
      return;
    }
    if (req.headers.origin) {
      res.setHeader('access-control-allow-origin', req.headers.origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.vary('Origin');
      res.setHeader(
        'access-control-allow-headers',
        'Content-Type, Authorization, X-Access-Passcode, X-Schema-Hash, X-Upgrade-CSRF, X-Operation-Id',
      );
      res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader(
        'access-control-expose-headers',
        'X-Schema-Hash, Content-Disposition, Content-Length',
      );
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.get('/internal/control/identity', async (req, res) => {
    const supplied = req.headers['x-platform-internal-key'];
    if (
      typeof supplied !== 'string' ||
      supplied.length !== key.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(key)) ||
      req.headers['x-platform-instance-id'] !== instanceId ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
    ) {
      res.sendStatus(403);
      return;
    }
    // Imports and forbidden authority are verified from this role's actual
    // loaded graph/environment. Physical coordinator evidence stays separate.
    const loaded = Object.keys(require.cache);
    const prohibited = loaded.some((path) =>
      /@boxlite\/|better-sqlite3|platform\/persistence\/(?:platform\.module|drizzle\.connection)|sandbox\/.*providers\//.test(
        path,
      ),
    );
    let authority: Record<string, unknown> | null = null;
    try {
      const response = await fetch(
        (await coordinatorTarget()).origin + '/internal/application/identity',
        {
          headers: internalHeaders,
          signal: AbortSignal.timeout(1000),
        },
      );
      if (response.ok) authority = z.record(z.unknown()).parse(await response.json());
    } catch {
      /* Missing authority evidence stays unknown. */
    }
    res.json({
      instanceId,
      role: 'control',
      pid: process.pid,
      startIdentity: process.env.PLATFORM_PROCESS_START_IDENTITY ?? null,
      artifactDigest: installedArtifact?.artifactDigest ?? null,
      inputFingerprint: installedArtifact?.inputFingerprint ?? null,
      protocol: catalog.protocol,
      controlOnly: !prohibited,
      noRuntimeSideEffects: !prohibited,
      applicationOperations: catalog.routes.length,
      actualCoordinatorArtifactDigest: authority?.artifactDigest ?? null,
      actualCoordinatorInputFingerprint: authority?.inputFingerprint ?? null,
      coordinatorGeneration: authority?.coordinatorGeneration ?? null,
      writerFenceValid: authority?.writerFenceValid ?? false,
    });
  });
  function original(req: Request): ApplicationRequest['request'] {
    const headers: ApplicationRequest['request']['headers'] = {};
    for (const name of [
      'host',
      'origin',
      'cookie',
      'authorization',
      'x-access-passcode',
      'x-upgrade-csrf',
      'prefer',
      'x-schema-hash',
      'x-operation-id',
      'sec-fetch-site',
      'x-forwarded-proto',
    ]) {
      const value = req.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    if (req.path === '/api/system/upgrade/probe') {
      for (const name of ['x-platform-internal-key', 'x-platform-instance-id']) {
        const value = req.headers[name];
        if (value !== undefined) headers[name] = value;
      }
    }
    return {
      method: req.method,
      path: req.path,
      headers,
      query: req.query,
      remoteAddress: req.socket.remoteAddress ?? 'unknown',
    };
  }
  async function invoke(
    operation: string,
    args: unknown[],
    req: Request,
    res: Response,
    operationId = String(req.headers['x-operation-id'] ?? ids.next()),
  ): Promise<void> {
    const payload: ApplicationRequest = { operation, operationId, args, request: original(req) };
    const abort = new AbortController();
    res.once('close', () => {
      abort.abort();
    });
    const rpc = await dispatch(payload, abort.signal, coordinatorDeadline(res));
    if (!rpc.ok) {
      const contentType = rpc.headers.get('content-type');
      if (contentType) res.setHeader('content-type', contentType);
      res.status(rpc.status).send(await rpc.text());
      return;
    }
    if (!rpc.body) throw new Error('APPLICATION_RPC_NO_BODY');
    let pending = '';
    let stream = false;
    for await (const bytes of rpc.body) {
      pending += Buffer.from(bytes).toString('utf8');
      if (pending.length > 32 * 1024 * 1024) throw new Error('APPLICATION_RPC_FRAME_TOO_LARGE');
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line) continue;
        const frame = ApplicationFrameSchema.parse(JSON.parse(line));
        if (frame.type === 'headers' && !res.headersSent) {
          res.status(frame.status);
          for (const [name, value] of Object.entries(frame.headers)) {
            if (
              req.path === '/api/system/upgrade/probe' &&
              protectedProbeHeaders.has(name.toLowerCase())
            )
              continue;
            res.setHeader(name, value);
          }
        } else if (frame.type === 'bytes') {
          stream = true;
          res.write(Buffer.from(frame.data, 'base64'));
        } else if (frame.type === 'result' && !stream) {
          if (res.statusCode === 204 || frame.value === undefined) res.end();
          else res.json(frame.value);
        } else if (frame.type === 'complete') {
          res.end();
          return;
        } else if (frame.type === 'error') {
          throw new Error(frame.code);
        }
      }
    }
    if (!res.writableEnded) throw new Error('APPLICATION_RESULT_UNCONFIRMED');
  }
  function failure(res: Response): void {
    if (!res.headersSent)
      res.status(503).json({
        code: 'APPLICATION_RESULT_UNKNOWN',
        message: '暂时无法确认原操作结果，请查询原请求',
        retryable: false,
      });
    else res.destroy();
  }
  async function dispatch(
    payload: ApplicationRequest,
    signal?: AbortSignal,
    deadline = clock.now().getTime() + 1900,
  ): Promise<globalThis.Response> {
    // Only an explicit rejection before journaling permits routing the SAME
    // operation to the new writer. A lost response is never an instruction to
    // retry a business effect.
    for (;;) {
      const target = await coordinatorTarget(deadline);
      const response = await fetch(target.origin + '/internal/application/invoke', {
        method: 'POST',
        headers: { ...internalHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      if (response.status !== 425) return response;
      const rawRejection: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      const rejection = isRecord(rawRejection) ? rawRejection : null;
      if (
        rejection?.code !== 'APPLICATION_WRITER_QUIESCED' ||
        rejection.sideEffectFree !== true ||
        clock.now().getTime() >= deadline
      )
        return response;
      await response.body?.cancel();
      await new Promise<void>((ok) => setTimeout(ok, 5));
    }
  }
  let applicationRouter = buildApplicationRouter(catalog);
  let refreshing: Promise<void> | undefined;
  async function refreshCatalog(deadline = clock.now().getTime() + 1900): Promise<void> {
    const target = await coordinatorTarget(deadline);
    if (catalogOrigin === target.origin) return;
    refreshing ??= (async () => {
      const response = await fetch(target.origin + '/internal/application/catalog', {
        headers: internalHeaders,
        signal: AbortSignal.timeout(Math.max(1, deadline - clock.now().getTime())),
      });
      if (!response.ok) throw new Error('APPLICATION_CATALOG_NOT_READY');
      const next = ApplicationCatalogSchema.parse(await response.json());
      if (!next.routes.length || next.protocol.min > 2 || next.protocol.max < 1)
        throw new Error('APPLICATION_PROTOCOL_INCOMPATIBLE');
      const router = buildApplicationRouter(next);
      catalog = next;
      catalogOrigin = target.origin;
      applicationRouter = router;
    })().finally(() => {
      refreshing = undefined;
    });
    await refreshing;
  }
  // The protocol catalog is a versioned allowlist of concrete application
  // operations. It is not an arbitrary HTTP path/method forwarding endpoint.
  function buildApplicationRouter(current: ApplicationCatalog): ReturnType<typeof express.Router> {
    const router = express.Router();
    for (const route of [...current.routes].sort((a, b) =>
      a.path.includes(':') === b.path.includes(':')
        ? b.path.length - a.path.length
        : a.path.includes(':')
          ? 1
          : -1,
    )) {
      const verb = route.verb.toLowerCase();
      const handler = (req: Request, res: Response): void => {
        const args: unknown[] = [];
        for (const arg of route.args) {
          if (arg.type === RouteParamtypes.BODY) {
            const body: unknown = req.body;
            args[arg.index] = arg.name ? (isRecord(body) ? body[arg.name] : undefined) : body;
          } else if (arg.type === RouteParamtypes.QUERY)
            args[arg.index] = arg.name ? req.query[arg.name] : req.query;
          else if (arg.type === RouteParamtypes.PARAM)
            args[arg.index] = arg.name ? req.params[arg.name] : req.params;
          else if (arg.type === RouteParamtypes.HEADERS)
            args[arg.index] = arg.name ? req.headers[arg.name] : req.headers;
          else if (arg.type === RouteParamtypes.IP) args[arg.index] = req.socket.remoteAddress;
          else args[arg.index] = null;
        }
        void invoke(route.operation, args, req, res).catch(() => {
          failure(res);
        });
      };
      if (verb === 'get') router.get(route.path, handler);
      else if (verb === 'post') router.post(route.path, handler);
      else if (verb === 'put') router.put(route.path, handler);
      else if (verb === 'delete') router.delete(route.path, handler);
      else if (verb === 'patch') router.patch(route.path, handler);
      else if (verb === 'head') router.head(route.path, handler);
    }
    return router;
  }
  app.use(async (req, res, next) => {
    if (!req.path.startsWith('/api/')) {
      next();
      return;
    }
    try {
      await refreshCatalog(coordinatorDeadline(res));
      applicationRouter(req, res, next);
    } catch {
      failure(res);
    }
  });
  const mcpRequestScope = new AsyncLocalStorage<Request>();
  function mcp(): ReturnType<typeof createLegacyMcpServer> {
    const server = createLegacyMcpServer();
    server.setRequestHandler(ListToolsRequestSchema, async () =>
      Promise.resolve({
        tools: catalog.tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      }),
    );
    server.setRequestHandler(CallToolRequestSchema, async (input) => {
      const req = mcpRequestScope.getStore();
      if (!req) throw new Error('MCP_REQUEST_IDENTITY_UNCONFIRMED');
      const tool = catalog.tools.find((t) => t.name === input.params.name);
      if (!tool) throw new Error('MCP_TOOL_NOT_ALLOWED');
      const result = await dispatch({
        operation: tool.operation,
        operationId: String(req.headers['x-operation-id'] ?? ids.next()),
        args: [input.params.arguments],
        request: original(req),
      });
      if (!result.ok) throw new Error('MCP_APPLICATION_REJECTED');
      let value: unknown;
      for (const line of (await result.text()).split('\n').filter(Boolean)) {
        const frame = ApplicationFrameSchema.parse(JSON.parse(line));
        if (frame.type === 'headers' && frame.status >= 400)
          throw new Error('MCP_APPLICATION_REJECTED');
        if (frame.type === 'error') throw new Error(frame.code);
        if (frame.type === 'result') value = frame.value;
      }
      return CallToolResultSchema.parse(value);
    });
    return server;
  }
  const streams = new Map<string, StreamableHTTPServerTransport>(),
    sses = new Map<string, ReturnType<typeof createLegacySseTransport>>();
  app.use(['/mcp', '/sse', '/messages'], async (req, res, next) => {
    try {
      await refreshCatalog(coordinatorDeadline(res));
      const auth = await fetch(
        (await coordinatorTarget()).origin + '/internal/application/authenticate',
        {
          method: 'POST',
          headers: { ...internalHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({
            operation: 'authenticate',
            operationId: ids.next(),
            args: [],
            request: original(req),
          }),
        },
      );
      if (!auth.ok) {
        const contentType = auth.headers.get('content-type');
        if (contentType) res.setHeader('content-type', contentType);
        res.status(auth.status).send(await auth.text());
        return;
      }
      const result = z
        .object({ headers: z.record(z.union([z.string(), z.number(), z.array(z.string())])) })
        .parse(await auth.json());
      for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
      next();
    } catch {
      failure(res);
    }
  });
  app.all('/mcp', async (req, res) => {
    try {
      const id = req.headers['mcp-session-id'];
      let transport = typeof id === 'string' ? streams.get(id) : undefined;
      if (!transport) {
        if (req.method !== 'POST') {
          res.sendStatus(400);
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => ids.next(),
          onsessioninitialized: (sessionId) => {
            if (!transport) throw new Error('MCP_TRANSPORT_NOT_INITIALIZED');
            streams.set(sessionId, transport);
          },
        });
        await mcp().connect(transport);
      }
      await mcpRequestScope.run(req, () => transport.handleRequest(req, res, req.body));
    } catch {
      failure(res);
    }
  });
  app.get('/sse', async (_req, res) => {
    try {
      const transport = createLegacySseTransport('/messages', res);
      sses.set(transport.sessionId, transport);
      res.once('close', () => sses.delete(transport.sessionId));
      await mcp().connect(transport);
    } catch {
      failure(res);
    }
  });
  app.post('/messages', async (req, res) => {
    const transport =
      typeof req.query.sessionId === 'string' ? sses.get(req.query.sessionId) : undefined;
    if (!transport) {
      res.sendStatus(404);
      return;
    }
    await mcpRequestScope.run(req, () => transport.handlePostMessage(req, res, req.body));
  });
  // Socket.IO retains its real Coordinator gateway and authenticated native
  // stream. This is transport plumbing; business HTTP/MCP use named DTO RPC.
  app.use('/socket.io', async (req, res) => {
    let actual: URL;
    try {
      actual = await coordinatorTarget();
    } catch {
      failure(res);
      return;
    }
    const proxy = httpRequest(
      {
        hostname: actual.hostname,
        port: actual.port,
        method: req.method,
        path: req.originalUrl,
        headers: req.headers,
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      },
    );
    proxy.once('error', () => {
      failure(res);
    });
    if (req.body !== undefined) proxy.end(JSON.stringify(req.body));
    else req.pipe(proxy);
  });
  const server = createServer(app);
  server.on('upgrade', (req, socket, head) => {
    void proxyUpgrade(req, socket, head).catch(() => socket.destroy());
  });
  async function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const method = req.method,
      url = req.url;
    if (!method || !url?.startsWith('/socket.io') || !isRequestOriginAllowed(req, network)) {
      socket.destroy();
      return;
    }
    let actual: URL;
    try {
      actual = await coordinatorTarget();
    } catch {
      socket.destroy();
      return;
    }
    const target = connect({ host: actual.hostname, port: Number(actual.port) });
    target.once('connect', () => {
      let headers = `${method} ${url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        headers += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      target.write(headers + '\r\n');
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    socket.once('close', () => target.destroy());
    target.once('close', () => socket.destroy());
    target.once('error', () => socket.destroy());
    socket.once('error', () => target.destroy());
  }
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(Number(process.env.PORT ?? 3001), process.env.HOST ?? '127.0.0.1', ok);
  });
  return server;
}
if (require.main === module)
  void startControlApi()
    .then((server) => {
      for (const signal of ['SIGINT', 'SIGTERM'])
        process.once(signal, () => {
          server.close(() => process.exit(0));
        });
    })
    .catch(() => {
      console.error('CONTROL_API_BOOT_FAILED');
      process.exitCode = 1;
    });
