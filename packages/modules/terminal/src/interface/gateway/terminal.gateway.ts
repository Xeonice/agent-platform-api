import { randomBytes } from 'node:crypto';
import { Inject, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import {
  SandboxProviderError,
  TERMINAL_AUTHENTICATOR,
  TERMINAL_EXIT_ATTACH_FAILED,
  WS_SCHEMA_HASH,
  X_SCHEMA_HASH_HEADER,
  wsHandshakeError,
} from '@platform/contracts';
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
 *   - Handshake carries X-Schema-Hash (14 §2.5 scheme B) and is REQUIRED to; it is
 *     refused in MIDDLEWARE with a machine-readable code (`WsHandshakeRejection`),
 *     never by accepting the socket and disconnecting it — see `afterInit`.
 *   - Since S5 the gateway ALWAYS ATTACHES the tmux session provision started
 *     (`TerminalSessionService.openSession`); it no longer starts the agent itself.
 *   - tmux re-attach grace window (06 §6) is a SKELETON — S1 kills the pty on
 *     disconnect; `?socketSessionKey=` is accepted for the future reuse path.
 */
@WebSocketGateway({ namespace: '/terminal' })
export class TerminalGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('TerminalGateway');
  private readonly attachments = new Map<string, Attachment>();

  constructor(
    private readonly sessions: TerminalSessionService,
    @Inject(TERMINAL_AUTHENTICATOR) private readonly auth: TerminalAuthenticator,
  ) {}

  /**
   * Refuse a bad handshake in socket.io MIDDLEWARE, exactly like `/tasks`.
   *
   * ⚠️ WHY NOT `handleConnection` + `disconnect(true)` — MEASURED, not theoretical.
   * The client identifies an unauthorized handshake from `connect_error`; a server that
   * accepts the socket and then tears it down never produces one, so `onUnauthorized`
   * COULD NOT FIRE: with the passcode gate on, the terminal never showed the unlock
   * dialog and just reconnected forever. The same mechanism swallowed the X-Schema-Hash
   * mismatch — the entire reason that handshake field exists. A middleware rejection
   * travels as `connect_error`, which socket.io guarantees to deliver, and it happens
   * before the socket joins the namespace, so there is nothing to unwind.
   *
   * ⚠️ NOTHING ABOUT THE SESSION SEMANTICS MOVES. `socketSessionKey` is still minted
   * per accepted connection in `handleConnection`, and the reconnect credential
   * (`?socketSessionKey=`) is still read there and handed to `openSession` as `reuse`
   * (08 §11.6) — the middleware only ever answers "may this handshake proceed", and it
   * does not read, require or invalidate that key.
   */
  afterInit(server: Namespace): void {
    server.use((socket, next) => {
      const rejection = this.rejectHandshake(socket);
      if (rejection) {
        this.logger.warn(`terminal handshake rejected: ${rejection.message}`);
        next(rejection);
        return;
      }
      next();
    });
  }

  /** `null` ⇒ the handshake is acceptable. Order is load-bearing — see each comment. */
  private rejectHandshake(client: Socket): Error | null {
    // access-passcode gate FIRST (S1 audit P1-1): the REST guard self-exempts
    // non-HTTP contexts, so the WS handshake must re-check the passcode/session
    // itself. It runs BEFORE any other probe so an UNAUTHENTICATED client cannot
    // use the distinct rejection codes to fingerprint the server (e.g. probe
    // the schema-hash) — every rejection looks the same until it is authorized.
    if (!this.auth.authorize(this.readCredentials(client))) {
      return wsHandshakeError('UNAUTHORIZED', 'missing or invalid access passcode');
    }
    // ⚠️ THE HASH IS REQUIRED, NOT MERELY CHECKED-IF-PRESENT. It used to read
    // `presented && presented !== …`, i.e. it could only ever catch a client that was
    // already being careful enough to send one — the client that does not need
    // catching. A `/terminal` frame drift shows up on the other side as frames that
    // simply do not render; the handshake is the only place it can be reported as
    // itself.
    const presented = this.readSchemaHash(client);
    if (presented !== WS_SCHEMA_HASH) {
      return wsHandshakeError(
        'SCHEMA_MISMATCH',
        `expected ${WS_SCHEMA_HASH}, got ${presented ?? 'none'}`,
      );
    }
    // Addressing, checked LAST — a client that cannot agree on the frame shapes is
    // better told THAT, and it is the older client, so the more useful diagnosis wins.
    const sandboxId = this.readQuery(client, 'sandboxId');
    if (sandboxId === undefined || sandboxId === '') {
      return wsHandshakeError(
        'SANDBOX_REQUIRED',
        'the handshake query must name the sandbox this terminal attaches to (?sandboxId=…)',
      );
    }
    return null;
  }

  async handleConnection(client: Socket): Promise<void> {
    // Past the middleware, so the handshake is authorized, version-agreed and addressed.
    // `sandboxId` cannot be absent here; the fallback keeps this method total rather
    // than asserting, and `openSession` would reject an empty id anyway.
    const sandboxId = this.readQuery(client, 'sandboxId') ?? '';
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
      // ⚠️ **先说一声再挂断,但只对不可重试的失败说。**
      //
      // 此前这里是一句不说的 `disconnect(true)`,而"连上又断"与网络抖动在客户端看来
      // 完全一样 —— 于是它只能按抖动处理:退避重连,而每一次都走进同一个 catch。实测:
      // 连上 → 1ms 后挂断、零帧,前端烧完 9 次退避(约 2 分钟)才停,而那个「手动重连」
      // 每按一次又清零预算重来一轮。
      //
      // 但**不能一律判死**:能从这里抛出来的不只有"容器已被回收"这种永久故障,还有
      // `PROVIDER_UNAVAILABLE` 这类瞬时故障(名字本身就在说该重试)。一律发终止信号
      // 等于把本来能自愈的抖动也判成永久故障。判据用 `SandboxProviderError.retryable`
      // —— 它本来就在契约里,不需要另造一套。
      //
      // 码用 `TERMINAL_EXIT_ATTACH_FAILED`(-2)而不是 -1:后者已经表示"进程退出但退出码
      // 未知"(被信号杀死),复用会让"agent 被 OOM kill"和"沙箱整个不在了"变成字节级
      // 相同的一帧,而这两件事对用户的下一步完全不同。
      if (this.isRetryableAttachFailureImpl(e)) {
        client.disconnect(true); // 保持沉默：让客户端的退避重连照旧自愈
        return;
      }
      this.send(client, { type: 'exit', code: TERMINAL_EXIT_ATTACH_FAILED });
      client.disconnect(true);
    }
  }

  /**
   * 这次附着失败值不值得客户端再试一次。
   *
   * `SandboxProviderError` 自带 `retryable`,是契约里现成的判据。非 provider 错误
   * (例如 tmux 探测抛的裸 Error)按**不可重试**处理:宁可让用户看到一句明确的
   * "会话已结束、请重新发起",也好过让他盯着两分钟注定失败的重连。
   */
  private isRetryableAttachFailureImpl(e: unknown): boolean {
    return e instanceof SandboxProviderError && e.retryable;
  }
  /**
   * WS 断开 = **detach**,不是结束(06 §6.2 / §6.3:"kill 掉的只是网关侧的 `tmux attach`
   * 进程, agent 会话不受影响")。
   *
   * ⚠️ 这里此前调的是 `stream.kill()`。对 PTY 来说 kill 的信号通道**就是 pty 本身**——
   * 它往终端里写 ETX + `exit\n`。那两下直接落进 tmux 面板里的 shell:先 SIGINT 掉用户
   * 正在跑的 agent,再试图结束它的 shell。也就是说**每关一次标签页/刷新一次页面,平台
   * 就打断一次正在跑的任务**——而 tmux 之所以是硬性镜像要求(`IMAGE_CONTRACT_VIOLATION`),
   * 全部理由就是"会话必须活过前端断连"。
   *
   * 这个 bug 当时以一种荒诞的方式暴露:ETX 之后 bash 正在重画提示符,`exit\n` 撞进这个
   * 重画窗口,首字节丢了,于是 shell 收到的是 `xit`——**恰恰是这个丢字节救了会话**,
   * 否则 shell 早就退干净了,现象会变成"刷新一下任务就没了"。
   */ handleDisconnect(client: Socket): void {
    const att = this.attachments.get(client.id);
    if (att) {
      att.stream.detach();
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
