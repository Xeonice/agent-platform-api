import { Inject, Logger } from '@nestjs/common';
import { type OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { TERMINAL_AUTHENTICATOR } from '@platform/contracts';
import type {
  SandboxEventBroadcaster,
  SandboxWsEvent,
  TerminalAuthenticator,
  TerminalHandshakeCredentials,
} from '@platform/contracts';

/**
 * `/events` socket.io gateway (shared/10 §7.4; 26 §10). Fans committed sandbox
 * state projections out to every connected client (single-tenant MVP — no
 * per-user filtering). Frames discriminate on `event` (deliberately different
 * from /terminal's `type`, §7.4). The handshake is passcode-gated FIRST (reuses
 * the shared TerminalAuthenticator, reading the `ap_session` cookie / passcode) —
 * an unauthorized socket is refused before anything else, exactly like /terminal.
 *
 * It IS the `SandboxEventBroadcaster` the sandbox projector pushes into.
 */
@WebSocketGateway({ namespace: '/events' })
export class EventsGateway implements OnGatewayConnection, SandboxEventBroadcaster {
  private readonly logger = new Logger('EventsGateway');

  @WebSocketServer()
  private readonly server!: Namespace;

  constructor(@Inject(TERMINAL_AUTHENTICATOR) private readonly auth: TerminalAuthenticator) {}

  handleConnection(client: Socket): void {
    if (!this.auth.authorize(this.readCredentials(client))) {
      this.logger.warn('events handshake rejected: missing/invalid access passcode');
      client.disconnect(true);
    }
  }

  /** Broadcast a projected event to all connected /events sockets. */
  broadcast(event: SandboxWsEvent): void {
    this.server?.emit('event', event);
  }

  private readCredentials(client: Socket): TerminalHandshakeCredentials {
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    const fromAuth =
      typeof auth?.['passcode'] === 'string' ? (auth['passcode'] as string) : undefined;
    const header = client.handshake.headers['x-access-passcode'];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    const authz = client.handshake.headers.authorization;
    const fromBearer = authz?.startsWith('Bearer ') ? authz.slice('Bearer '.length) : undefined;
    const query = client.handshake.query['passcode'];
    const fromQuery = Array.isArray(query) ? query[0] : query;
    return {
      passcode: fromAuth ?? fromHeader ?? fromBearer ?? fromQuery,
      sessionToken: this.readCookie(client, 'ap_session'),
    };
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
}
