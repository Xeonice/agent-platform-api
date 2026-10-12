import 'reflect-metadata';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import {
  TERMINAL_AUTHENTICATOR,
  type RuntimeAdapterRegistry,
  type TerminalServerFrame,
} from '@platform/contracts';
import {
  RuntimeOwnerConnection,
  RuntimeOwnerProcessStream,
} from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-client';
import { TerminalGateway } from '../../../packages/modules/terminal/src/interface/gateway/terminal.gateway';
import { TerminalSessionService } from '../../../packages/modules/terminal/src/application/terminal-session.service';
import { WaitingInputService } from '../../../packages/modules/terminal/src/application/waiting-input.service';
import { WaitingInputDetector } from '../../../packages/modules/terminal/src/infrastructure/waiting-input/waiting-input.detector';
import type { TerminalBookmark } from '../../../packages/modules/terminal/src/domain/ports/terminal-bookmarks.port';

const key = 'isolated-runtime-transport-key-at-least-32-characters';
const instance = 'isolated-runtime-transport';
const publicIdentity = 'ee66d40d-10ac-4284-a893-7a7cbd8818bd';
const contexts: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const context of contexts.splice(0).reverse()) await context.close();
});

/** Only the external stream/tmux results are controlled. HTTP, the production
 * owner client, Nest gateway, Socket.IO and terminal confirmation are real.
 * This regression is not evidence of a native VM or authenticated role chain. */
async function transport(failFirstRead = false) {
  let response: ServerResponse | undefined;
  let gets = 0;
  const actions: string[] = [];
  const server = createServer((req, res) => {
    if (
      req.headers['x-platform-internal-key'] !== key ||
      req.headers['x-platform-instance-id'] !== instance
    ) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/runtime/streams/')) {
      gets++;
      response = res;
      setTimeout(() => {
        if (res.destroyed) return;
        if (failFirstRead) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 'PROVIDER_UNAVAILABLE', message: 'Read unavailable' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.flushHeaders();
        res.write(
          JSON.stringify({
            type: 'data',
            seq: 1,
            data: Buffer.from('original guest output').toString('base64'),
          }) + '\n',
        );
      }, 120);
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (bytes: Buffer) => chunks.push(bytes));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString()) as { method: string };
      actions.push(input.method);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const connection = new RuntimeOwnerConnection({
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    key,
    instanceId: instance,
    generation: 1,
    clock: { now: () => new Date() },
  });
  const streams: RuntimeOwnerProcessStream[] = [];
  const open = () => {
    const stream = new RuntimeOwnerProcessStream(
      'original-stream',
      'a'.repeat(40),
      'external-fixture',
      connection,
      'original-sandbox',
      'external-fixture-runtime',
    );
    streams.push(stream);
    return stream;
  };
  const context = {
    actions,
    open,
    getCount: () => gets,
    interrupt: () => response?.destroy(),
    close: async () => {
      for (const stream of streams) stream.detach();
      connection.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  contexts.push(context);
  return context;
}

async function gateway(source: Awaited<ReturnType<typeof transport>>) {
  const runtimes: RuntimeAdapterRegistry = {
    get: () => {
      throw new Error('An attach cannot start an agent');
    },
    register: () => {
      throw new Error('Fixed external fixture');
    },
    has: () => false,
    list: () => [],
  };
  let bookmark: TerminalBookmark | undefined;
  const sessions = new TerminalSessionService(
    runtimes,
    {
      bindingOf: async (sandboxId) => ({
        sandboxId,
        runtimeId: 'claude-code',
        availableRuntimes: ['claude-code'],
        workdir: '/workspace',
      }),
      execFor: async () => async (cmd) => ({
        exitCode: 0,
        stdout: cmd.includes('display-message') ? '321:$0:123456\n' : '',
        stderr: '',
      }),
    },
    { openPty: async () => source.open() },
    {
      ensure: async (sandboxId, kind, privateSessionId) =>
        (bookmark ??= { sandboxId, kind, privateSessionId, terminalIdentity: publicIdentity }),
      resolve: async () => bookmark ?? null,
      confirm: async (_sandbox, identity, runtimeIdentity) => {
        if (!bookmark || identity !== bookmark.terminalIdentity) return false;
        bookmark.runtimeIdentity = runtimeIdentity;
        return true;
      },
    },
  );
  const waiting = new WaitingInputService(
    new WaitingInputDetector(
      { now: () => new Date() },
      { broadcast: () => undefined },
      { silenceSec: 10, promptPatterns: [] },
    ),
  );
  const module = await Test.createTestingModule({
    providers: [
      TerminalGateway,
      { provide: TerminalSessionService, useValue: sessions },
      { provide: WaitingInputService, useValue: waiting },
      { provide: TERMINAL_AUTHENTICATOR, useValue: { authorize: () => true } },
    ],
  }).compile();
  // A WS-only test intentionally does not duplicate REST bootstrap configuration.
  const app = module.createNestApplication();
  await app.listen(0, '127.0.0.1');
  const client: Socket = io((await app.getUrl()) + '/terminal', {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    autoConnect: false,
    query: { sandboxId: 'original-sandbox', protocolMin: '1', protocolMax: '2' },
  });
  const frames: TerminalServerFrame[] = [];
  const errors: string[] = [];
  client.on('frame', (frame: TerminalServerFrame) => frames.push(frame));
  client.on('connect_error', (error: Error) => errors.push(error.message));
  contexts.push({
    close: async () => {
      client.disconnect();
      await app.close();
    },
  });
  return { client, frames, errors };
}

describe('observed RuntimeOwner read state and terminal attach', () => {
  it('does not report a read failure before the delayed HTTP response, then replays the actual connected observation', async () => {
    const t = await transport();
    const stream = t.open();
    const states: string[] = [];
    stream.onConnectionState((state) => states.push(state));
    expect(states).toEqual([]);
    await vi.waitFor(() => expect(states).toEqual(['connected']));
    const late: string[] = [];
    stream.onConnectionState((state) => late.push(state));
    expect(late).toEqual(['connected']);
    expect(t.getCount()).toBe(1);
  });

  it('delivers a real initial HTTP failure as unconfirmed without inventing a guest exit', async () => {
    const t = await transport(true);
    const stream = t.open();
    const states: string[] = [];
    const exits: (number | null)[] = [];
    stream.onConnectionState((state) => states.push(state));
    stream.onExit((code) => exits.push(code));
    expect(states).toEqual([]);
    await vi.waitFor(() => expect(states).toEqual(['unconfirmed']));
    const late: string[] = [];
    stream.onConnectionState((state) => late.push(state));
    expect(late).toEqual(['unconfirmed']);
    expect(exits).toEqual([]);
  });

  it('allows the actual Nest gateway to confirm the original terminal after a delayed HTTP stream, but detaches on a later real transport loss [AC-UPG-003.1]', async () => {
    const t = await transport();
    const g = await gateway(t);
    g.client.connect();
    await vi.waitFor(() => expect(g.frames.some((frame) => frame.type === 'ready')).toBe(true));
    expect(g.client.connected).toBe(true);
    expect(g.errors).toEqual([]);
    expect(g.frames.find((frame) => frame.type === 'ready')).toMatchObject({
      sandboxId: 'original-sandbox',
      terminalIdentity: publicIdentity,
      runtimeIdentity: 'external-fixture-runtime/tmux:321:$0:123456',
      existingSession: true,
    });
    expect(g.frames.some((frame) => frame.type === 'connection_state')).toBe(false);
    expect(t.actions).toEqual([]);
    t.interrupt();
    await vi.waitFor(() =>
      expect(
        g.frames.some(
          (frame) => frame.type === 'connection_state' && frame.state === 'unconfirmed',
        ),
      ).toBe(true),
    );
    await vi.waitFor(() => expect(g.client.disconnected).toBe(true));
    await vi.waitFor(() => expect(t.actions).toContain('stream.detach'));
    expect(g.frames.some((frame) => frame.type === 'exit')).toBe(false);
    expect(t.actions.every((action) => action === 'stream.detach')).toBe(true);
  });
});
