import { Inject, Logger, type OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import {
  TERMINAL_AUTHENTICATOR,
  WS_TASKS_SCHEMA_HASH,
  X_SCHEMA_HASH_HEADER,
} from '@platform/contracts';
import type {
  TaskClientFrame,
  TaskServerFrame,
  TerminalAuthenticator,
  TerminalHandshakeCredentials,
} from '@platform/contracts';
import { AgentTaskApplicationService } from '../../application/agent-task.service';
import { TaskEventHub } from '../../application/task-event.hub';

/**
 * Codes a `/tasks` handshake can be refused with. They are the WIRE contract of the
 * rejection: the client dispatches on them, so they lead the message and are repeated
 * on `err.data`.
 *
 * ⚠️ ONLY `UNAUTHORIZED` MAY LOOK LIKE AN AUTH FAILURE. The client's shared
 * "is this unauthorized?" helper matches the message against
 * /unauthor|forbidden|passcode|401|403/i, so none of those words may appear in a
 * `SCHEMA_MISMATCH` or a `SANDBOX_REQUIRED` message — being mistaken for one pops the
 * unlock dialog, which for a protocol-version drift or a missing query parameter is
 * worse than useless: it sends the user to do the one thing that cannot possibly help.
 *
 * ⚠️ AND `SANDBOX_REQUIRED` IS DELIBERATELY NOT SPELLED `UNAUTHORIZED`. A handshake
 * that omits `sandboxId` presented a perfectly good access passcode; what is missing is
 * ADDRESSING, and the platform has no per-caller scope for this rule to be
 * authorisation OF (the same distinction `requireTask` draws on the REST side). Reusing
 * `UNAUTHORIZED` would be a lie told twice: it would misname the fault AND route the
 * user to the unlock dialog, which cannot add a query parameter the client itself
 * failed to send.
 */
export type TasksHandshakeRejection = 'UNAUTHORIZED' | 'SCHEMA_MISMATCH' | 'SANDBOX_REQUIRED';

function handshakeError(code: TasksHandshakeRejection, detail: string): Error {
  const err = new Error(`${code}: ${detail}`) as Error & { data?: { code: string } };
  err.data = { code };
  return err;
}

/** One socket's interest in one task. */
interface Subscription {
  socket: Socket;
  /** Frames that arrived while the replay was still running (see `subscribe`). */
  pending: TaskServerFrame[];
  replaying: boolean;
  /** Highest `seq` this socket has already been sent — the de-duplication key. */
  deliveredSeq: number;
  exitSent: boolean;
  /**
   * Cleared when this subscription is superseded or removed.
   *
   * ⚠️ WITHOUT IT A SECOND `subscribe` ON THE SAME SOCKET DOUBLES EVERY FRAME. The map
   * is keyed by `client.id`, so the new Subscription replaces the old one — but the
   * OLD replay loop is still running and still holds a reference to the OLD object, and
   * the de-duplication high-water mark lives ON that object. Two live objects ⇒ two
   * independent `deliveredSeq` counters ⇒ the socket receives every event twice. The
   * frontend reconnect path re-sends `subscribe` on every `open`, so this is the
   * ordinary case, not an exotic one.
   */
  live: boolean;
}

/**
 * `/tasks` socket.io gateway (ws-protocol `TaskClientFrame` / `TaskServerFrame`).
 *
 * ── Why a THIRD namespace instead of an eighth `/events` event ───────────────────
 * `/events` frames are business projections that ride the outbox for at-least-once
 * delivery. Task output is a high-volume byte-derived stream — a long run emits
 * thousands of frames — and it already has a durable home in the platform's own JSONL
 * log. Putting it through the outbox would be pure write amplification AND would
 * drown the projection channel the entire UI depends on. Same reasoning that keeps
 * `/terminal` separate.
 *
 * ── The two cursors are NOT the same cursor ──────────────────────────────────────
 * `seq` is the platform's OWN dense per-task counter, assigned as each event is
 * produced. The provider's `JobCursor` is an opaque byte offset that stops at the
 * platform boundary and is never sent here. `fromSeq` therefore means "the next event
 * I have not seen", and the frontend never learns a byte offset exists.
 *
 * ── The replay/live handoff, and why it is not a `setTimeout` ────────────────────
 * A subscriber must receive every event exactly once, in order, with no gap — the
 * contract says a gap in `seq` is a bug, not something to tolerate. So a subscription
 * is registered BEFORE the replay starts (live frames cannot be missed) and live
 * frames are BUFFERED until the replay finishes (they cannot arrive early). The flush
 * then drops anything with a `seq` the replay already covered, which is exact because
 * `seq` is dense and monotonic.
 */
@WebSocketGateway({ namespace: '/tasks' })
export class TasksGateway implements OnGatewayInit, OnGatewayDisconnect, OnModuleInit {
  private readonly logger = new Logger('TasksGateway');
  /** taskId → socketId → subscription. */
  private readonly subscriptions = new Map<string, Map<string, Subscription>>();

  constructor(
    private readonly app: AgentTaskApplicationService,
    private readonly hub: TaskEventHub,
    @Inject(TERMINAL_AUTHENTICATOR) private readonly auth: TerminalAuthenticator,
  ) {}

  /**
   * Attach to the producer side. Going through the hub rather than BEING the
   * broadcaster is what keeps gateway → service → workflow → broadcaster from closing
   * into a cycle (see `TaskEventHub`).
   */
  onModuleInit(): void {
    this.hub.onFrame((taskId, frame) => this.publish(taskId, frame));
  }

  /**
   * Reject a bad handshake in socket.io MIDDLEWARE, not after the connection exists.
   *
   * ⚠️ WHY NOT `handleConnection` + `disconnect(true)`. That path has to emit a frame
   * and then tear the transport down, which is a race it cannot win reliably — the
   * client may never see the frame. A middleware rejection travels as `connect_error`,
   * which socket.io GUARANTEES to deliver, and it happens before the socket is ever
   * added to the namespace, so there is nothing to unwind.
   *
   * ⚠️ AND WHY THE MESSAGE STARTS WITH A CODE. The client dispatches on the message
   * text, so `UNAUTHORIZED`, `SCHEMA_MISMATCH` and `SANDBOX_REQUIRED` must be
   * distinguishable by machine: a version mismatch — or a forgotten query parameter —
   * read as "not authorized" would pop the unlock dialog, sending the user to do the one
   * thing that cannot possibly help. The code is also repeated on `err.data.code` for a
   * client that would rather not parse prose at all.
   */
  afterInit(server: Namespace): void {
    server.use((socket, next) => {
      const rejection = this.rejectHandshake(socket);
      if (rejection) {
        this.logger.warn(`tasks handshake rejected: ${rejection.message}`);
        next(rejection);
        return;
      }
      next();
    });
  }

  /** `null` ⇒ the handshake is acceptable. */
  private rejectHandshake(client: Socket): Error | null {
    // access-passcode gate FIRST, exactly like /terminal and /events: the REST guard
    // self-exempts non-HTTP contexts, so the WS handshake re-checks it itself. This
    // channel carries agent OUTPUT — the contents of a private repository, in general
    // — so an unauthenticated socket must never reach the subscribe path.
    if (!this.auth.authorize(this.readCredentials(client))) {
      return handshakeError('UNAUTHORIZED', 'missing or invalid access passcode');
    }
    // Frame-schema agreement, checked AFTER auth so an unauthenticated client cannot
    // use the distinct rejection codes to fingerprint the server (same order as
    // /terminal). `/tasks` carries its OWN hash: a task-frame change must not
    // invalidate every open terminal, and vice versa.
    //
    // ⚠️ THE HASH IS REQUIRED, NOT MERELY CHECKED-IF-PRESENT. The old
    // `presented !== undefined &&` let every client that simply omits it straight
    // through — i.e. the check could only ever catch a client that was already being
    // careful, which is the one that does not need catching. A `/tasks` frame is parsed
    // by a zod union on the other side, so a shape drift shows up as frames being
    // silently DROPPED; the handshake is the only place it can be reported as itself.
    const presented = this.readSchemaHash(client);
    if (presented !== WS_TASKS_SCHEMA_HASH) {
      return handshakeError(
        'SCHEMA_MISMATCH',
        `expected ${WS_TASKS_SCHEMA_HASH}, got ${presented ?? 'none'}`,
      );
    }
    // Addressing, checked LAST — a client that cannot even agree on the frame shapes is
    // better told THAT, and it is the older client, so the more useful diagnosis wins.
    //
    // ⚠️ IT IS REQUIRED, NOT MERELY CHECKED-IF-PRESENT — the same lesson the schema hash
    // taught, applied here. While it was optional, a socket that simply omitted it could
    // `subscribe` to ANY task in the deployment by id, so the rule could only ever bind
    // the client that was already scoping itself: the one that does not need binding.
    // REST has no such hole (`requireTask` treats the sandbox id in the path as part of
    // the task's identity), and two shells that disagree about who may read what is not
    // a difference worth keeping.
    //
    // It lives in the HANDSHAKE QUERY rather than on the frame, which is what makes the
    // change affordable at all: `TaskClientFrame.subscribe` has no `sandboxId`, and
    // adding one would move `WS_PROTOCOL_CANONICAL` / `WS_TASKS_SCHEMA_HASH`, which must
    // be bumped in lockstep across both repos. The query is also exactly how `/terminal`
    // scopes itself, so this is the established shape and not a new one.
    const scope = this.readQuery(client, 'sandboxId');
    if (scope === undefined || scope === '') {
      return handshakeError(
        'SANDBOX_REQUIRED',
        'the handshake query must name the sandbox this socket is watching (?sandboxId=…)',
      );
    }
    return null;
  }

  handleDisconnect(client: Socket): void {
    for (const [taskId, subs] of this.subscriptions) {
      const sub = subs.get(client.id);
      if (sub) sub.live = false; // stop a replay loop that is still running for it
      subs.delete(client.id);
      if (subs.size === 0) this.subscriptions.delete(taskId);
    }
  }

  @SubscribeMessage('frame')
  async onFrame(
    @ConnectedSocket() client: Socket,
    @MessageBody() frame: TaskClientFrame,
  ): Promise<void> {
    switch (frame.type) {
      case 'subscribe':
        await this.subscribe(client, frame.taskId, frame.fromSeq ?? 0);
        return;
      case 'unsubscribe':
        this.unsubscribe(client, frame.taskId);
        return;
      case 'ping':
        this.send(client, { type: 'pong' });
        return;
    }
  }

  /** Deliver one produced frame to every socket subscribed to that task. */
  private publish(taskId: string, frame: TaskServerFrame): void {
    const subs = this.subscriptions.get(taskId);
    if (!subs) return;
    for (const sub of subs.values()) {
      if (sub.replaying) {
        sub.pending.push(frame);
        continue;
      }
      this.deliver(sub, frame);
    }
  }

  private async subscribe(client: Socket, taskId: string, fromSeq: number): Promise<void> {
    const task = await this.app.findTask(taskId);
    // The SAME addressing rule as REST's `requireTask`, and now unconditionally: the
    // handshake refuses a socket that did not declare a sandbox, so every socket that
    // reaches here has one and every socket is held to it.
    //
    // The scope is read from the HANDSHAKE, never from the frame. A frame is whatever
    // the client typed a millisecond ago; the query was fixed when the connection was
    // admitted, which is what stops one socket from re-scoping itself per subscribe. And
    // the comparison fails CLOSED: `undefined` — unreachable past the middleware, but
    // free to be exact about — equals no sandbox id, so a hole in the middleware would
    // deny rather than admit.
    const scope = this.readQuery(client, 'sandboxId');
    if (!task || task.sandboxId !== scope) {
      // a CODE, never a sentence — the frontend renders the 人话 (P22 §1).
      this.send(client, { type: 'error', taskId, code: 'NOT_FOUND' });
      // ⚠️ AND A TERMINATING FRAME. A bare `error` leaves the subscriber inside
      // "回放中" forever: `caught_up` is the only thing that ends the replay phase, and
      // for a task that does not exist there is no `exit` coming either. Returning
      // without one is how a panel gets stuck on 运行中 until the tab is closed.
      this.send(client, { type: 'caught_up', taskId, firstSeq: fromSeq + 1, seq: fromSeq });
      return;
    }
    // Retire whatever this socket was subscribed to before. The map is keyed by
    // `client.id`, so a second `subscribe` REPLACES the entry — but the previous
    // replay loop still holds the previous object, and the de-duplication high-water
    // mark lives on it, so without this the socket sees every event twice. The
    // frontend re-sends `subscribe` on every reconnect, so this is routine.
    const previous = this.byTask(taskId).get(client.id);
    if (previous) previous.live = false;
    // register FIRST so nothing produced during the replay can be missed.
    const sub: Subscription = {
      socket: client,
      pending: [],
      replaying: true,
      deliveredSeq: fromSeq,
      exitSent: false,
      live: true,
    };
    this.byTask(taskId).set(client.id, sub);

    // `firstSeq` is what makes a TRUNCATED replay detectable: a subscriber comparing it
    // against `fromSeq + 1` learns that the head is missing, which a gap check on `seq`
    // alone cannot reveal. An empty replay reports `seq + 1` — an empty range.
    let firstSeq: number | undefined;
    try {
      for (const { seq, event } of await this.app.replay(taskId, fromSeq)) {
        if (!sub.live) return; // superseded (or the socket went away) mid-replay
        firstSeq ??= seq;
        this.deliver(sub, { type: 'event', taskId, seq, event });
      }
    } catch (e) {
      this.logger.error(`replay for task ${taskId} failed: ${(e as Error).message}`);
      this.send(client, { type: 'error', taskId, code: 'REPLAY_FAILED' });
    }

    // everything after this frame is live (contract wording, and it is literally true:
    // the buffered frames flushed below all post-date the replay).
    this.send(client, {
      type: 'caught_up',
      taskId,
      firstSeq: firstSeq ?? sub.deliveredSeq + 1,
      seq: sub.deliveredSeq,
    });
    sub.replaying = false;
    if (!sub.live) return;
    for (const frame of sub.pending.splice(0)) this.deliver(sub, frame);

    // A task that ALREADY finished will never publish an exit frame again, so a late
    // subscriber would otherwise wait forever for a terminal state it can already see.
    const current = await this.app.findTask(taskId);
    if (current && !current.isRunning && !sub.exitSent) {
      this.deliver(sub, {
        type: 'exit',
        taskId,
        status: current.status,
        ...(current.exitCode !== null ? { exitCode: current.exitCode } : {}),
      });
    }
  }

  private unsubscribe(client: Socket, taskId: string): void {
    const subs = this.subscriptions.get(taskId);
    if (!subs) return;
    const sub = subs.get(client.id);
    if (sub) sub.live = false;
    subs.delete(client.id);
    if (subs.size === 0) this.subscriptions.delete(taskId);
  }

  /**
   * Send one frame, dropping anything this socket already has.
   *
   * The `seq` check is what makes the replay→live handoff exact rather than
   * approximate: a frame the replay covered and the buffer also caught is delivered
   * ONCE, and a gap is impossible because both sources number the same dense sequence.
   */
  private deliver(sub: Subscription, frame: TaskServerFrame): void {
    // a superseded subscription's replay loop keeps its own `deliveredSeq`, so letting
    // it deliver would send the socket a second copy of everything it is replaying.
    if (!sub.live) return;
    if (frame.type === 'event') {
      if (frame.seq <= sub.deliveredSeq) return;
      sub.deliveredSeq = frame.seq;
    }
    if (frame.type === 'exit') {
      if (sub.exitSent) return;
      sub.exitSent = true;
    }
    this.send(sub.socket, frame);
  }

  private byTask(taskId: string): Map<string, Subscription> {
    let subs = this.subscriptions.get(taskId);
    if (!subs) {
      subs = new Map();
      this.subscriptions.set(taskId, subs);
    }
    return subs;
  }

  private send(client: Socket, frame: TaskServerFrame): void {
    client.emit('frame', frame);
  }

  private readSchemaHash(client: Socket): string | undefined {
    const header = client.handshake.headers[X_SCHEMA_HASH_HEADER];
    if (header) return Array.isArray(header) ? header[0] : header;
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    const fromAuth = auth?.['xSchemaHash'];
    if (typeof fromAuth === 'string') return fromAuth;
    return this.readQuery(client, 'xSchemaHash');
  }

  private readQuery(client: Socket, key: string): string | undefined {
    const v = client.handshake.query[key];
    return Array.isArray(v) ? v[0] : v;
  }

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
}
