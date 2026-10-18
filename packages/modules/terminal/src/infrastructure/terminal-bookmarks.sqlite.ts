import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  DATABASE,
  ID_GENERATOR,
  UNIT_OF_WORK,
  CLOCK,
  type Clock,
  type IdGenerator,
  type UnitOfWork,
  type Tx,
} from '@platform/shared-kernel';
import type { TerminalBookmarkCleanup } from '@platform/contracts';
import type { TerminalBookmark, TerminalBookmarks } from '../domain/ports/terminal-bookmarks.port';

@Injectable()
export class SqliteTerminalBookmarks implements TerminalBookmarks, TerminalBookmarkCleanup {
  constructor(
    @Inject(DATABASE) private readonly db: BetterSQLite3Database,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}
  deleteForSandboxSync(_tx: Tx, sandboxId: string): void {
    this.db.run(sql`DELETE FROM terminal_bookmarks WHERE sandbox_id=${sandboxId}`);
  }
  async markCloseRequested(sandboxId: string, privateSessionId: string): Promise<void> {
    this.uow.run(() => {
      this.db.run(
        sql`UPDATE terminal_bookmarks SET close_requested_at=coalesce(close_requested_at,${this.clock.now().getTime()}) WHERE sandbox_id=${sandboxId} AND private_session_id=${privateSessionId} AND kind IN ('shell','runtime')`,
      );
    });

    return Promise.resolve();
  }
  async ensure(
    sandboxId: string,
    kind: TerminalBookmark['kind'],
    privateSessionId: string,
    runtimeId?: string,
  ): Promise<TerminalBookmark> {
    return Promise.resolve(
      this.uow.run(() => {
        this.db.run(
          sql`INSERT OR IGNORE INTO terminal_bookmarks(terminal_identity,sandbox_id,kind,private_session_id,runtime_id) SELECT ${this.ids.next()},${sandboxId},${kind},${privateSessionId},${runtimeId ?? null} WHERE EXISTS (SELECT 1 FROM sandboxes WHERE id=${sandboxId} AND status NOT IN ('destroying','destroyed'))`,
        );
        const row = this.db.get<{ terminal_identity: string } | undefined>(
          sql`SELECT terminal_identity FROM terminal_bookmarks WHERE sandbox_id=${sandboxId} AND kind=${kind} AND private_session_id=${privateSessionId} AND EXISTS (SELECT 1 FROM sandboxes WHERE id=${sandboxId} AND status NOT IN ('destroying','destroyed'))`,
        );
        if (!row) throw new Error('TERMINAL_BOOKMARK_NOT_COMMITTED');
        return {
          terminalIdentity: row.terminal_identity,
          sandboxId,
          kind,
          privateSessionId,
          ...(runtimeId ? { runtimeId } : {}),
        };
      }),
    );
  }
  async resolve(sandboxId: string, terminalIdentity: string): Promise<TerminalBookmark | null> {
    const row = this.db.get<
      | {
          terminal_identity: string;
          sandbox_id: string;
          kind: TerminalBookmark['kind'];
          private_session_id: string;
          runtime_id: string | null;
          runtime_identity: string | null;
        }
      | undefined
    >(
      sql`SELECT * FROM terminal_bookmarks WHERE sandbox_id=${sandboxId} AND terminal_identity=${terminalIdentity} AND EXISTS (SELECT 1 FROM sandboxes WHERE id=${sandboxId} AND status NOT IN ('destroying','destroyed'))`,
    );
    return Promise.resolve(
      row
        ? {
            terminalIdentity: row.terminal_identity,
            sandboxId: row.sandbox_id,
            kind: row.kind,
            privateSessionId: row.private_session_id,
            ...(row.runtime_id ? { runtimeId: row.runtime_id } : {}),
            ...(row.runtime_identity ? { runtimeIdentity: row.runtime_identity } : {}),
          }
        : null,
    );
  }
  async confirm(
    sandboxId: string,
    terminalIdentity: string,
    runtimeIdentity: string,
  ): Promise<boolean> {
    return Promise.resolve(
      this.uow.run(() => {
        const row = this.db.get<{ runtime_identity: string | null } | undefined>(
          sql`SELECT runtime_identity FROM terminal_bookmarks WHERE sandbox_id=${sandboxId} AND terminal_identity=${terminalIdentity} AND EXISTS (SELECT 1 FROM sandboxes WHERE id=${sandboxId} AND status NOT IN ('destroying','destroyed'))`,
        );
        if (!row || (row.runtime_identity && row.runtime_identity !== runtimeIdentity))
          return false;
        this.db.run(
          sql`UPDATE terminal_bookmarks SET runtime_identity=${runtimeIdentity} WHERE sandbox_id=${sandboxId} AND terminal_identity=${terminalIdentity} AND (runtime_identity IS NULL OR runtime_identity=${runtimeIdentity})`,
        );
        return true;
      }),
    );
  }
}
