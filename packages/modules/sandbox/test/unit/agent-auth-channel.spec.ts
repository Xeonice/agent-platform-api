import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxProviderErrorCode } from '@platform/contracts';
import { AioSandboxAgentClient } from '../../src/infrastructure/providers/aio/aio-sandbox-agent.client';

/**
 * The agent channel must carry the sandbox's credential on EVERY call — the whole
 * point of 加固 1 is that the loopback-published agent port stops answering
 * unauthenticated callers, which only helps if the platform itself is
 * authenticated. Driven against a recording fake agent so both transports are
 * pinned without a container:
 *
 *   HTTP (exec/kill/close/file-write) → `Authorization: Bearer <token>`
 *   WS   (interactive pty)            → a `?ticket=` minted over authenticated HTTP
 *
 * The websocket case is the interesting one: the runtime's WHATWG `WebSocket`
 * cannot send headers, so the token CANNOT ride the upgrade. The agent's own
 * ticket endpoint is the sanctioned way across that gap, and a failure to mint one
 * must NOT fall back to an anonymous connect. The live-image proof is
 * aio-agent-auth.e2e-spec.ts.
 */
interface Seen {
  url: string;
  authorization?: string;
}

class RecordingAgent {
  readonly seen: Seen[] = [];
  /** when false, /tickets answers 500 (simulates a locked-down/broken agent). */
  ticketsWork = true;
  private server!: Server;
  private port = 0;

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res) => {
      this.seen.push({ url: req.url ?? '', authorization: req.headers.authorization });
      req.on('data', () => undefined); // drain; the fake does not need the body
      req.on('end', () => {
        if (req.url === '/tickets') {
          if (!this.ticketsWork) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ detail: 'nope' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ticket: 'TICKET-123', expires_in: 30 }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            message: 'ok',
            data: { status: 'completed', stdout: 'hi', exit_code: 0 },
          }),
        );
      });
    });
    // a plain HTTP server never answers 101, so the ws upgrade fails AFTER we have
    // recorded the URL the client tried — exactly what we want to assert on.
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
  }

  base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

let agent: RecordingAgent;

beforeEach(async () => {
  agent = new RecordingAgent();
  await agent.start();
});

afterEach(async () => {
  await agent.stop();
});

describe('AioSandboxAgentClient — credential on the wire', () => {
  it('sends the bearer token on every HTTP call', async () => {
    const client = new AioSandboxAgentClient(agent.base(), 'TOK');
    const stream = await client.exec({ tty: false, cmd: ['echo', 'hi'] });
    await new Promise<void>((r) => stream.onExit(() => r()));

    expect(agent.seen.length).toBeGreaterThan(0);
    // exec + session close both go out; not one of them may be anonymous.
    for (const call of agent.seen) {
      expect(call.authorization).toBe('Bearer TOK');
    }
    expect(agent.seen.map((c) => c.url)).toContain('/v1/bash/exec');
  });

  it('sends no Authorization header when the sandbox has no token', async () => {
    const client = new AioSandboxAgentClient(agent.base());
    const stream = await client.exec({ tty: false, cmd: ['echo', 'hi'] });
    await new Promise<void>((r) => stream.onExit(() => r()));
    for (const call of agent.seen) {
      expect(call.authorization).toBeUndefined();
    }
  });

  it('mints a ticket over authenticated HTTP and puts it on the websocket URL', async () => {
    const client = new AioSandboxAgentClient(agent.base(), 'TOK');
    // the fake never completes the upgrade, so this rejects — after the handshake
    // attempt has been recorded.
    await expect(client.openTerminal(80, 24)).rejects.toBeDefined();

    const tickets = agent.seen.find((c) => c.url === '/tickets');
    expect(tickets?.authorization).toBe('Bearer TOK');

    const upgrade = agent.seen.find((c) => c.url.startsWith('/v1/shell/ws'));
    expect(upgrade?.url).toBe('/v1/shell/ws?ticket=TICKET-123');
  });

  it('opens the websocket bare when there is no token to trade', async () => {
    const client = new AioSandboxAgentClient(agent.base());
    await expect(client.openTerminal(80, 24)).rejects.toBeDefined();
    expect(agent.seen.some((c) => c.url === '/tickets')).toBe(false);
    expect(agent.seen.some((c) => c.url === '/v1/shell/ws')).toBe(true);
  });

  it('fails loud rather than connecting anonymously when the ticket is refused', async () => {
    agent.ticketsWork = false;
    const client = new AioSandboxAgentClient(agent.base(), 'TOK');
    await expect(client.openTerminal(80, 24)).rejects.toMatchObject({
      code: SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
    });
    // the decisive assertion: no downgrade — the socket was never attempted.
    expect(agent.seen.some((c) => c.url.startsWith('/v1/shell/ws'))).toBe(false);
  });
});
