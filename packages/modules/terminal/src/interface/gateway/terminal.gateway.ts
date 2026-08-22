import { randomBytes } from 'node:crypto';
import { Inject, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { TERMINAL_AUTHENTICATOR, WS_SCHEMA_HASH, X_SCHEMA_HASH_HEADER } from '@platform/contracts';
import type {
  ProcessStream,
  TerminalAuthenticator,
  TerminalClientFrame,
  TerminalHandshakeCredentials,
  TerminalServerFrame,
} from '@platform/contracts';
import { TerminalSessionService } from '../../application/terminal-session.service';

interface Attachment {
  stream: ProcessStream;
  socketSessionKey: string;
  sandboxId: string;
}

/**
 * /terminal socket.io gateway (docs/backend/06). Bridges xterm ⇄ ProcessStream.
 *   - `socketSessionKey` is SERVER-generated 128-bit (audit P2-9), sent in the
 *     first `session` frame; never client-chosen.
 *   - Frames follow shared/10 §7.4 (`type` discriminator; data is plain string).
 *   - Handshake carries X-Schema-Hash (14 §2.5 scheme B): loud reject on mismatch.
 *   - Since S5 the gateway ALWAYS ATTACHES the tmux session provision started
 *     (`TerminalSessionService.openSession`); it no longer starts the agent itself.
 *   - tmux re-attach grace window (06 §6) is a SKELETON — S1 kills the pty on
 *     disconnect; `?socketSessionKey=` is accepted for the future reuse path.
 */
@WebSocketGateway({ namespace: '/terminal' })
export class TerminalGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('TerminalGateway');
  private readonly attachments = new Map<string, Attachment>();

  constructor(
    private readonly sessions: TerminalSessionService,
    @Inject(TERMINAL_AUTHENTICATOR) private readonly auth: TerminalAuthenticator,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    // access-passcode gate FIRST (S1 audit P1-1): the REST guard self-exempts
    // non-HTTP contexts, so the WS handshake must re-check the passcode/session
    // itself. It runs BEFORE any other probe so an UNAUTHENTICATED client cannot
    // use the distinct disconnect reasons to fingerprint the server (e.g. probe
    // the schema-hash) — every rejection looks the same until it is authorized.
    if (!this.auth.authorize(this.readCredentials(client))) {
      this.logger.warn('terminal handshake rejected: missing/invalid access passcode');
      client.disconnect(true);
      return;
    }

    const presented = this.readSchemaHash(client);
    if (presented && presented !== WS_SCHEMA_HASH) {
      this.logger.warn(
        `WS schema-hash mismatch (client=${presented} server=${WS_SCHEMA_HASH}); refusing connection`,
      );
      client.disconnect(true);
      return;
    }

    const sandboxId = this.readQuery(client, 'sandboxId');
    if (!sandboxId) {
      this.logger.warn('terminal connection without sandboxId; refusing');
      client.disconnect(true);
      return;
    }
    const cols = Number(this.readQuery(client, 'cols') ?? 80);
    const rows = Number(this.readQuery(client, 'rows') ?? 24);
    const reuse = this.readQuery(client, 'socketSessionKey');

    try {
      // ALWAYS attach the agent session provision already started (26 §8 / 裁决 D-15).
      // The gateway no longer decides "is this the first session?" and never calls
      // buildStartCommand — that moved into bootstrapAgentSession.
      const stream = await this.sessions.openSession(sandboxId, { cols, rows, reuse });
      const socketSessionKey = randomBytes(16).toString('hex'); // 128-bit, server-generated
      this.attachments.set(client.id, { stream, socketSessionKey, sandboxId });

      this.send(client, { type: 'session', socketSessionKey });
      stream.onData((chunk) => this.send(client, { type: 'data', data: chunk.toString('utf8') }));
      stream.onExit((code) => {
        this.send(client, { type: 'exit', code: code ?? -1 });
        client.disconnect(true);
      });
    } catch (e) {
      this.logger.error(`openSession failed for sandbox ${sandboxId}: ${(e as Error).message}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    const att = this.attachments.get(client.id);
    if (att) {
      void att.stream.kill().catch(() => undefined);
      this.attachments.delete(client.id);
    }
  }

  @SubscribeMessage('frame')
  onFrame(@ConnectedSocket() client: Socket, @MessageBody() frame: TerminalClientFrame): void {
    const att = this.attachments.get(client.id);
    if (!att) return;
    switch (frame.type) {
      case 'input':
        att.stream.write(frame.data);
        break;
      case 'resize':
        att.stream.resize(frame.cols, frame.rows);
        break;
      case 'ping':
        this.send(client, { type: 'pong' });
        break;
    }
  }

  private send(client: Socket, frame: TerminalServerFrame): void {
    client.emit('frame', frame);
  }

  private readQuery(client: Socket, key: string): string | undefined {
    const v = client.handshake.query[key];
    return Array.isArray(v) ? v[0] : v;
  }

  /** Pull the passcode (auth/query/header) + `ap_session` cookie off the handshake. */
  private readCredentials(client: Socket): TerminalHandshakeCredentials {
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    const fromAuth =
      typeof auth?.['passcode'] === 'string' ? (auth['passcode'] as string) : undefined;
    const header = client.handshake.headers['x-access-passcode'];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    const authz = client.handshake.headers.authorization;
    const fromBearer = authz?.startsWith('Bearer ') ? authz.slice('Bearer '.length) : undefined;
    const passcode = fromAuth ?? fromHeader ?? fromBearer ?? this.readQuery(client, 'passcode');
    return { passcode, sessionToken: this.readCookie(client, 'ap_session') };
  }

  private readCookie(client: Socket, name: string): string | undefined {
    const raw = client.handshake.headers.cookie;
    if (!raw) return undefined;
    for (const part of raw.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === name) return decodeURIComponent(rest.join('='));
    }
    return undefined;
  }

  private readSchemaHash(client: Socket): string | undefined {
    const header = client.handshake.headers[X_SCHEMA_HASH_HEADER];
    if (header) return Array.isArray(header) ? header[0] : header;
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    const fromAuth = auth?.['xSchemaHash'];
    if (typeof fromAuth === 'string') return fromAuth;
    return this.readQuery(client, 'xSchemaHash');
  }
}
