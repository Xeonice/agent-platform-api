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
import { SANDBOX_PTY_PORT, WS_SCHEMA_HASH, X_SCHEMA_HASH_HEADER } from '@platform/contracts';
import type {
  ProcessStream,
  SandboxPtyPort,
  TerminalClientFrame,
  TerminalServerFrame,
} from '@platform/contracts';

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
 *   - tmux re-attach grace window (06 §6) is a SKELETON — S1 kills the pty on
 *     disconnect; `?socketSessionKey=` is accepted for the future reuse path.
 */
@WebSocketGateway({ namespace: '/terminal' })
export class TerminalGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('TerminalGateway');
  private readonly attachments = new Map<string, Attachment>();

  constructor(@Inject(SANDBOX_PTY_PORT) private readonly pty: SandboxPtyPort) {}

  async handleConnection(client: Socket): Promise<void> {
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
      const stream = await this.pty.openPty(sandboxId, { cols, rows, reuse });
      const socketSessionKey = randomBytes(16).toString('hex'); // 128-bit, server-generated
      this.attachments.set(client.id, { stream, socketSessionKey, sandboxId });

      this.send(client, { type: 'session', socketSessionKey });
      stream.onData((chunk) => this.send(client, { type: 'data', data: chunk.toString('utf8') }));
      stream.onExit((code) => {
        this.send(client, { type: 'exit', code: code ?? -1 });
        client.disconnect(true);
      });
    } catch (e) {
      this.logger.error(`openPty failed for sandbox ${sandboxId}: ${(e as Error).message}`);
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

  private readSchemaHash(client: Socket): string | undefined {
    const header = client.handshake.headers[X_SCHEMA_HASH_HEADER];
    if (header) return Array.isArray(header) ? header[0] : header;
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    const fromAuth = auth?.['xSchemaHash'];
    if (typeof fromAuth === 'string') return fromAuth;
    return this.readQuery(client, 'xSchemaHash');
  }
}
