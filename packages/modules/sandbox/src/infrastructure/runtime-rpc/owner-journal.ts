import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { fromEpochMs, type Clock } from '@platform/shared-kernel';
import {
  SandboxProviderError,
  SandboxProviderErrorCode,
  type RuntimeOwnerCall,
  type RuntimeOwnerFence,
  type RuntimeOwnerLease,
  type RuntimeOwnerLeaseClaim,
  type SandboxHandle,
} from '@platform/contracts';
import { decodeOwnerValue, encodeOwnerValue } from './wire-codec';

type Operation = {
  digest: string;
  state: 'pending' | 'complete' | 'failed';
  result: string | null;
};
type Assignment = {
  sandbox_id: string;
  provider: string;
  handle: string;
  state: 'owned' | 'destroyed';
};

/** Owner-private journal; it never opens the platform business database. */
export class RuntimeOwnerJournal {
  private readonly db: Database.Database;
  constructor(
    path: string,
    readonly instanceId: string,
    readonly ownerId: string,
    private readonly clock: Clock,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 1000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owner_identity (id INTEGER PRIMARY KEY CHECK(id=1), instance_id TEXT NOT NULL, owner_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS owner_lease (id INTEGER PRIMARY KEY CHECK(id=1), session_id TEXT NOT NULL, generation INTEGER NOT NULL, fence INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS owner_operations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','complete','failed')), result TEXT, actor TEXT NOT NULL, generation INTEGER NOT NULL, fence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS owner_assignments (sandbox_id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_id TEXT NOT NULL, handle TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('owned','destroyed')), UNIQUE(provider,provider_id));
      CREATE TABLE IF NOT EXISTS owner_reservations (sandbox_id TEXT PRIMARY KEY, provider TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state='unconfirmed'));
      CREATE TABLE IF NOT EXISTS owner_effect_audit (operation_id TEXT PRIMARY KEY, method TEXT NOT NULL,
        sandbox_id TEXT, actor TEXT NOT NULL, generation INTEGER NOT NULL, fence INTEGER NOT NULL,
        state TEXT NOT NULL, dispatched_at INTEGER NOT NULL, completed_at INTEGER);
    `);
    const identity = this.db
      .prepare('SELECT instance_id, owner_id FROM owner_identity WHERE id=1')
      .get() as { instance_id: string; owner_id: string } | undefined;
    if (identity && (identity.instance_id !== instanceId || identity.owner_id !== ownerId)) {
      this.db.close();
      throw new Error('RuntimeOwner home belongs to a different instance or owner');
    }
    this.db.prepare('INSERT OR IGNORE INTO owner_identity VALUES(1,?,?)').run(instanceId, ownerId);
  }

  lease(): RuntimeOwnerLease | null {
    const row = this.db
      .prepare('SELECT session_id,generation,fence,expires_at FROM owner_lease WHERE id=1')
      .get() as
      { session_id: string; generation: number; fence: number; expires_at: number } | undefined;
    return row
      ? {
          instanceId: this.instanceId,
          holderId: 'state-coordinator',
          sessionId: row.session_id,
          generation: row.generation,
          fence: row.fence,
          leaseExpiresAt: row.expires_at,
        }
      : null;
  }

  claim(input: RuntimeOwnerLeaseClaim): RuntimeOwnerLease {
    return this.db.transaction(() => {
      if (input.instanceId !== this.instanceId) this.reject('Instance mismatch');
      const previous = this.lease();
      const now = this.clock.now().getTime();
      if (
        previous &&
        previous.sessionId === input.sessionId &&
        previous.generation === input.generation
      ) {
        if (previous.fence !== input.expectedFence) this.reject('Stale lease renewal');
        if (previous.leaseExpiresAt <= now)
          this.reject('Expired lease requires a fresh session and fence');
        const expires = now + input.ttlMs;
        this.db.prepare('UPDATE owner_lease SET expires_at=? WHERE id=1').run(expires);
        return { ...previous, leaseExpiresAt: expires };
      }
      if ((previous?.fence ?? 0) !== input.expectedFence)
        this.reject('Lease compare-and-set conflict');
      if (previous && (previous.leaseExpiresAt > now || input.generation <= previous.generation))
        this.reject('RuntimeOwner still has an authoritative coordinator');
      const fence = (previous?.fence ?? 0) + 1;
      const leaseExpiresAt = now + input.ttlMs;
      this.db
        .prepare(
          'INSERT INTO owner_lease VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,generation=excluded.generation,fence=excluded.fence,expires_at=excluded.expires_at',
        )
        .run(input.sessionId, input.generation, fence, leaseExpiresAt);
      return {
        instanceId: this.instanceId,
        holderId: 'state-coordinator' as const,
        sessionId: input.sessionId,
        generation: input.generation,
        fence,
        leaseExpiresAt,
      };
    })();
  }

  validate(fence: RuntimeOwnerFence, mutation: boolean): void {
    if (fence.instanceId !== this.instanceId) this.reject('Instance mismatch');
    if (!mutation) return;
    const lease = this.lease();
    if (
      fence.authority !== 'business' ||
      !lease ||
      lease.sessionId !== fence.sessionId ||
      lease.generation !== fence.generation ||
      lease.fence !== fence.fence ||
      lease.leaseExpiresAt <= this.clock.now().getTime() ||
      fence.leaseExpiresAt > lease.leaseExpiresAt ||
      fence.leaseExpiresAt <= this.clock.now().getTime()
    ) {
      this.reject('RuntimeOwner mutation fence is not authoritative');
    }
  }
  release(input: {
    instanceId: string;
    sessionId: string;
    generation: number;
    fence: number;
  }): void {
    this.db
      .transaction(() => {
        const lease = this.lease();
        if (
          input.instanceId !== this.instanceId ||
          !lease ||
          lease.sessionId !== input.sessionId ||
          lease.generation !== input.generation ||
          lease.fence !== input.fence ||
          lease.leaseExpiresAt <= this.clock.now().getTime()
        )
          this.reject('Only the current coordinator may release its runtime lease');
        this.db
          .prepare('UPDATE owner_lease SET expires_at=0 WHERE id=1 AND session_id=? AND fence=?')
          .run(input.sessionId, input.fence);
      })
      .immediate();
  }

  begin(call: RuntimeOwnerCall): { cached: boolean; value?: unknown } {
    return this.db.transaction(() => {
      this.validate(call.fence, true);
      const digest = createHash('sha256')
        .update(
          JSON.stringify(
            encodeOwnerValue({
              provider: call.provider,
              method: call.method,
              args: call.args,
              sandboxId: call.fence.sandboxId,
            }),
          ),
        )
        .digest('hex');
      const old = this.db
        .prepare('SELECT digest,state,result FROM owner_operations WHERE id=?')
        .get(call.fence.operationId) as Operation | undefined;
      if (old) {
        if (old.digest !== digest) this.reject('Operation identity reused with different input');
        if (old.state !== 'complete' || old.result === null)
          this.reject('Operation result is unknown; reconcile before issuing a new intent');
        return { cached: true, value: decodeOwnerValue(JSON.parse(old.result) as unknown) };
      }
      if (call.method === 'create') {
        const sandboxId = call.fence.sandboxId;
        if (!sandboxId) this.reject('Create requires a durable sandbox identity');
        const reservation = this.db
          .prepare('SELECT operation_id FROM owner_reservations WHERE sandbox_id=?')
          .get(sandboxId);
        if (reservation)
          this.reject('Original create result is unconfirmed; resource remains reserved');
        this.db
          .prepare("INSERT INTO owner_reservations VALUES(?,?,?,'unconfirmed')")
          .run(sandboxId, call.provider, call.fence.operationId);
      }
      this.db
        .prepare("INSERT INTO owner_operations VALUES(?,?,'pending',NULL,?,?,?)")
        .run(
          call.fence.operationId,
          digest,
          JSON.stringify(call.fence.actor),
          call.fence.generation,
          call.fence.fence,
        );
      this.db
        .prepare("INSERT INTO owner_effect_audit VALUES(?,?,?,?,?,?,'pending',?,NULL)")
        .run(
          call.fence.operationId,
          call.method,
          call.fence.sandboxId ?? null,
          JSON.stringify(call.fence.actor),
          call.fence.generation,
          call.fence.fence,
          this.clock.now().getTime(),
        );
      return { cached: false };
    })();
  }

  complete(
    call: RuntimeOwnerCall,
    value: unknown,
    assign?: { sandboxId: string; handle: SandboxHandle },
    destroyedId?: string,
  ): void {
    this.db.transaction(() => {
      // The effect was fenced before dispatch. Record its actual immutable owner
      // receipt even if authority expired while native IO was in flight; this is
      // not permission for another effect or a platform business-ledger write.
      this.validate(call.fence, false);
      const intent = this.operation(call.fence.operationId);
      if (!intent || intent.state !== 'pending') this.reject('Runtime intent is not pending');
      if (assign) {
        const existing = this.assignmentBySandbox(assign.sandboxId);
        if (
          existing &&
          existing.state === 'owned' &&
          (existing.provider !== assign.handle.provider ||
            existing.handle !== JSON.stringify(assign.handle))
        )
          this.reject('Sandbox already belongs to another runtime assignment');
        this.db
          .prepare(
            "INSERT INTO owner_assignments VALUES(?,?,?,?,'owned') ON CONFLICT(sandbox_id) DO UPDATE SET provider=excluded.provider,provider_id=excluded.provider_id,handle=excluded.handle,state=excluded.state",
          )
          .run(
            assign.sandboxId,
            assign.handle.provider,
            assign.handle.providerSandboxId,
            JSON.stringify(assign.handle),
          );
        this.db
          .prepare('DELETE FROM owner_reservations WHERE sandbox_id=? AND operation_id=?')
          .run(assign.sandboxId, call.fence.operationId);
      }
      if (destroyedId)
        this.db
          .prepare("UPDATE owner_assignments SET state='destroyed' WHERE sandbox_id=?")
          .run(destroyedId);
      this.db
        .prepare(
          "UPDATE owner_operations SET state='complete',result=? WHERE id=? AND state='pending'",
        )
        .run(JSON.stringify(encodeOwnerValue(value)), call.fence.operationId);
      this.db
        .prepare(
          "UPDATE owner_effect_audit SET state='complete',completed_at=? WHERE operation_id=?",
        )
        .run(this.clock.now().getTime(), call.fence.operationId);
    })();
  }

  fail(operationId: string): void {
    this.db
      .prepare("UPDATE owner_operations SET state='failed' WHERE id=? AND state='pending'")
      .run(operationId);
    this.db
      .prepare(
        "UPDATE owner_effect_audit SET state='unknown' WHERE operation_id=? AND state='pending'",
      )
      .run(operationId);
  }
  continuity(): object {
    type AuditRow = {
      operation_id: string;
      method: string;
      sandbox_id: string | null;
      actor: string;
      generation: number;
      fence: number;
      state: string;
      dispatched_at: number;
      completed_at: number | null;
    };
    const rows = this.db
      .prepare('SELECT * FROM owner_effect_audit ORDER BY dispatched_at,operation_id')
      .all() as AuditRow[];
    const operations = rows.map((row) => ({
      id: row.operation_id,
      method: row.method,
      sandboxId: row.sandbox_id,
      actor: JSON.parse(row.actor) as { kind: string; id: string },
      generation: row.generation,
      fence: row.fence,
      state: row.state,
      dispatchedAt: fromEpochMs(row.dispatched_at).toISOString(),
      completedAt: row.completed_at === null ? null : fromEpochMs(row.completed_at).toISOString(),
    }));
    return {
      instanceId: this.instanceId,
      ownerId: this.ownerId,
      lease: this.lease(),
      assignments: this.assignments(),
      operations,
      observedAt: this.clock.now().toISOString(),
    };
  }
  operation(operationId: string): Operation | undefined {
    return this.db
      .prepare('SELECT digest,state,result FROM owner_operations WHERE id=?')
      .get(operationId) as Operation | undefined;
  }
  assignmentBySandbox(id: string): Assignment | undefined {
    return this.db
      .prepare('SELECT sandbox_id,provider,handle,state FROM owner_assignments WHERE sandbox_id=?')
      .get(id) as Assignment | undefined;
  }
  assignedHandle(provider: string, id: string, sandboxId?: string): SandboxHandle {
    const row = this.db
      .prepare(
        "SELECT sandbox_id,provider,handle,state FROM owner_assignments WHERE provider=? AND provider_id=? AND state='owned'",
      )
      .get(provider, id) as Assignment | undefined;
    if (!row || (sandboxId && row.sandbox_id !== sandboxId))
      this.reject('Unconfirmed runtime assignment');
    return JSON.parse(row.handle) as SandboxHandle;
  }
  assignments(): {
    sandboxId: string;
    provider: string;
    providerSandboxId: string;
    state: string;
  }[] {
    const confirmed = (
      this.db
        .prepare('SELECT sandbox_id,provider,provider_id,state FROM owner_assignments')
        .all() as { sandbox_id: string; provider: string; provider_id: string; state: string }[]
    ).map((row) => ({
      sandboxId: row.sandbox_id,
      provider: row.provider,
      providerSandboxId: row.provider_id,
      state: row.state,
    }));
    const unconfirmed = this.db
      .prepare('SELECT sandbox_id,provider FROM owner_reservations')
      .all() as { sandbox_id: string; provider: string }[];
    return [
      ...confirmed,
      ...unconfirmed.map((row) => ({
        sandboxId: row.sandbox_id,
        provider: row.provider,
        providerSandboxId: '',
        state: 'unconfirmed',
      })),
    ];
  }
  close(): void {
    this.db.close();
  }
  private reject(message: string): never {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
      message,
      undefined,
      true,
    );
  }
}
