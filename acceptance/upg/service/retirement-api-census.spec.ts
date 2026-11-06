import { it, expect } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
it('actual API process exposes private local census without forwarding; live HTTP/WS work drains before zero', async () => {
  const key = 'synthetic-api-census-private-key-32-characters',
    instanceId = 'own-api-census-fixture';
  let role: ChildProcessWithoutNullStreams | undefined,
    held: ServerResponse | undefined,
    forwards = 0;
  const upstreamSockets = new Set<Socket>();
  const upstream = createServer((req, res) => {
    if (req.url === '/internal/application/catalog') {
      res.end(
        JSON.stringify({
          protocol: { min: 1, max: 2 },
          tools: [],
          routes: [
            {
              path: '/api/census-fixture',
              verb: 'GET',
              operation: 'Fixture.read',
              status: 200,
              args: [],
            },
          ],
        }),
      );
      return;
    }
    forwards++;
    held = res;
    res.write(
      JSON.stringify({ type: 'headers', status: 200, headers: { 'content-type': 'text/plain' } }) +
        '\n',
    );
    res.write(
      JSON.stringify({ type: 'bytes', data: Buffer.from('active').toString('base64') }) + '\n',
    );
  });
  upstream.on('upgrade', (_req, socket) => {
    upstreamSockets.add(socket as Socket);
    socket.resume();
    socket.once('end', () => socket.end());
    socket.once('close', () => upstreamSockets.delete(socket as Socket));
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    );
  });
  await new Promise<void>((ok) => upstream.listen(0, '127.0.0.1', ok));
  let client: Socket | undefined;
  try {
    const childEnv = {
      ...process.env,
      PLATFORM_INSTANCE_ID: instanceId,
      PLATFORM_CONTROL_RPC_KEY: key,
      PLATFORM_PROCESS_START_IDENTITY: 'actual-api-census-fixture-start',
      COORDINATOR_RPC_URL: 'http://127.0.0.1:' + (upstream.address() as { port: number }).port,
      PORT: '0',
      HOST: '127.0.0.1',
    };
    for (const name of [
      'DATABASE_URL',
      'DATA_ROOT',
      'BOXLITE_HOME',
      'RUNTIME_OWNER_HOME',
      'PLATFORM_COORDINATOR_RPC_KEY',
      'PLATFORM_CONTROLLER_RPC_KEY',
      'PLATFORM_COORDINATOR_BINDING_PATH',
      'PLATFORM_ARTIFACT_DIGEST',
    ])
      delete (childEnv as NodeJS.ProcessEnv)[name];
    role = spawn(
      process.execPath,
      [
        '-e',
        `require(${JSON.stringify(resolve('apps/api/dist/roles/control-api-main.js'))}).startControlApi().then(s=>console.log('READY:'+s.address().port)).catch(()=>process.exit(1))`,
      ],
      { env: childEnv, stdio: 'pipe' },
    );
    const child = role;
    const port = await new Promise<number>((ok, fail) => {
      let text = '';
      const timer = setTimeout(() => fail(new Error('CENSUS_FIXTURE_START_TIMEOUT')), 5000);
      child.stdout.on('data', (bytes) => {
        text += String(bytes);
        const match = /READY:(\d+)/.exec(text);
        if (match) {
          clearTimeout(timer);
          ok(Number(match[1]));
        }
      });
      child.stderr.resume();
      child.once('exit', () => {
        clearTimeout(timer);
        fail(new Error('CENSUS_FIXTURE_EXITED'));
      });
    });
    const base = 'http://127.0.0.1:' + port;
    const read = async () => {
      const r = await fetch(base + '/internal/control/retirement', {
        headers: { 'x-platform-internal-key': key, 'x-platform-instance-id': instanceId },
      });
      expect(r.status).toBe(200);
      return (await r.json()) as { counts: { http: number; ws: number; workers: number } };
    };
    const before = forwards;
    expect((await read()).counts).toMatchObject({ http: 0, ws: 0, workers: 0 });
    expect(forwards).toBe(before);
    expect((await fetch(base + '/internal/control/retirement')).status).toBe(403);
    const abort = new AbortController();
    const response = await fetch(base + '/api/census-fixture', { signal: abort.signal });
    await response.body?.getReader().read();
    const busy = await read();
    expect(busy.counts.http).toBe(1);
    expect(busy.counts.workers).toBeGreaterThan(0);
    abort.abort();
    held?.destroy();
    const due = Date.now() + 2000;
    while ((await read()).counts.workers > 0 && Date.now() < due)
      await new Promise<void>((ok) => setTimeout(ok, 10));
    expect((await read()).counts).toMatchObject({ http: 0, workers: 0 });
    client = connect(port, '127.0.0.1');
    await new Promise<void>((ok, fail) => {
      client?.once('error', fail);
      client?.once('data', () => ok());
      client?.once('connect', () =>
        client?.write(
          'GET /socket.io/?transport=websocket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
        ),
      );
    });
    expect((await read()).counts.ws).toBe(1);
    client.destroy();
    const wsDue = Date.now() + 2000;
    while ((await read()).counts.ws > 0 && Date.now() < wsDue)
      await new Promise<void>((ok) => setTimeout(ok, 10));
    expect((await read()).counts).toMatchObject({ ws: 0, workers: 0 });
    expect(upstreamSockets.size).toBe(0);
  } finally {
    client?.destroy();
    held?.destroy();
    for (const socket of upstreamSockets) socket.destroy();
    if (role && role.exitCode === null) {
      role.kill('SIGTERM');
      await new Promise<void>((ok) => role?.once('exit', () => ok()));
    }
    upstream.closeAllConnections();
    await new Promise<void>((ok) => upstream.close(() => ok()));
  }
});
