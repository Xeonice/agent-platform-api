import { Inject, Logger } from '@nestjs/common';
import { type OnGatewayInit, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { TERMINAL_AUTHENTICATOR, wsHandshakeError } from '@platform/contracts';
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
 * from /terminal's `type`, §7.4). The handshake is passcode-gated (it reuses the shared
 * TerminalAuthenticator, reading the `ap_session` cookie / passcode) — an unauthorized
 * socket is refused before anything else, exactly like /terminal and /tasks.
 *
 * It IS the `SandboxEventBroadcaster` the sandbox projector pushes into.
 */
@WebSocketGateway({ namespace: '/events' })
export class EventsGateway implements OnGatewayInit, SandboxEventBroadcaster {
  private readonly logger = new Logger('EventsGateway');

  @WebSocketServer()
  private readonly server!: Namespace;

  constructor(@Inject(TERMINAL_AUTHENTICATOR) private readonly auth: TerminalAuthenticator) {}

  /**
   * Refuse in socket.io MIDDLEWARE, the same shape as `/terminal` and `/tasks`.
   *
   * ⚠️ WHAT `disconnect(true)` COST HERE. `/events` is the only realtime projection
   * source in the product — sandbox status, clone progress, runtime credential changes
   * all ride it. The frontend decides "was I refused for auth?" from `connect_error`,
   * which a connect-then-disconnect never produces, so with the passcode gate on the
   * unlock dialog never appeared and the whole workbench just sat in 「启动中…」 behind a
   * silent reconnect loop. And because this channel deliberately never gives up
   * retrying (it has nothing that expires, so stopping would protect nothing), the loop
   * had no end state either.
   *
   * ⚠️ `UNAUTHORIZED` IS THE ONLY CODE THIS NAMESPACE CAN CURRENTLY RAISE, and that is a
   * KNOWN GAP, not a design: `/terminal` and `/tasks` both gate on an X-Schema-Hash and
   * `/events` does not, so an `/events` frame drift has no handshake to report itself at
   * — it degrades into frames the client's zod union rejects one by one.
   *
   * ⏳ WHY IT IS NOT FIXED HERE. Closing it is a TWO-REPO change, not a tightening:
   * unlike `/terminal` (whose client has always sent `xSchemaHash`), the `/events`
   * client sends nothing, so requiring a hash backend-side would refuse 100% of real
   * connections — and this is the channel the entire workbench's live state rides on,
   * the one that never stops retrying. It needs, in lockstep: a `WS_EVENTS_SCHEMA_HASH`
   * in both repos' `ws-protocol.ts` (versioned SEPARATELY, for the reason `/tasks` is),
   * the check below it, and the query key on `web/src/services/ws/eventsSocket.ts`.
   * Landing the backend half alone would be a silent outage that no CI in either repo
   * can see.
   */
  afterInit(server: Namespace): void {
    server.use((socket, next) => {
      if (!this.auth.authorize(this.readCredentials(socket))) {
        this.logger.warn('events handshake rejected: missing/invalid access passcode');
        next(wsHandshakeError('UNAUTHORIZED', 'missing or invalid access passcode'));
        return;
      }
      next();
    });
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
