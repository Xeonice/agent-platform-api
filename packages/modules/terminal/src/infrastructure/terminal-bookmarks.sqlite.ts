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
} from '@platform/shared-kernel';
import type { TerminalBookmark, TerminalBookmarks } from '../domain/ports/terminal-bookmarks.port';

@Injectable()
export class SqliteTerminalBookmarks implements TerminalBookmarks {
  constructor(
    @Inject(DATABASE) private readonly db: BetterSQLite3Database<Record<string, never>>,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}
  async markCloseRequested(sandboxId: string, privateSessionId: string): Promise<void> {
    this.uow.run(() => {
      this.db.run(
        sql`UPDATE terminal_bookmarks SET close_requested_at=coalesce(close_requested_at,${this.clock.now().getTime()}) WHERE sandbox_id=${sandboxId} AND private_session_id=${privateSessionId} AND kind IN ('shell','runtime')`,
      );
    });
  }
  async ensure(
    sandboxId: string,
    kind: TerminalBookmark['kind'],
    privateSessionId: string,
    runtimeId?: string,
  ): Promise<TerminalBookmark> {
    return this.uow.run(() => {
      this.db.run(
        sql`INSERT OR IGNORE INTO terminal_bookmarks(terminal_identity,sandbox_id,kind,private_session_id,runtime_id) VALUES(${this.ids.next()},${sandboxId},${kind},${privateSessionId},${runtimeId ?? null})`,
      );
      const row = this.db.get<{ terminal_identity: string }>(
        sql`SELECT terminal_identity FROM terminal_bookmarks WHERE sandbox_id=${sandboxId} AND kind=${kind} AND private_session_id=${privateSessionId}`,
      );
      if (!row) throw new Error('TERMINAL_BOOKMARK_NOT_COMMITTED');
      return {
        terminalIdentity: row.terminal_identity,
        sandboxId,
        kind,
        privateSessionId,
        ...(runtimeId ? { runtimeId } : {}),
      };
    });
  }
  async resolve(sandboxId: string, terminalIdentity: string): Promise<TerminalBookmark | null> {
    const row = this.db.get<{
      terminal_identity: string;
      sandbox_id: string;
      kind: TerminalBookmark['kind'];
      private_session_id: string;
      runtime_id: string | null;
      runtime_identity: string | null;
    }>(
      sql`SELECT * FROM terminal_bookmarks WHERE sandbox_id=${sandboxId} AND terminal_identity=${terminalIdentity}`,
    );
    return row
      ? {
          terminalIdentity: row.terminal_identity,
          sandboxId: row.sandbox_id,
          kind: row.kind,
          privateSessionId: row.private_session_id,
          ...(row.runtime_id ? { runtimeId: row.runtime_id } : {}),
          ...(row.runtime_identity ? { runtimeIdentity: row.runtime_identity } : {}),
        }
      : null;
  }
  async confirm(
    sandboxId: string,
    terminalIdentity: string,
    runtimeIdentity: string,
  ): Promise<boolean> {
    return this.uow.run(() => {
      const row = this.db.get<{ runtime_identity: string | null }>(
        sql`SELECT runtime_identity FROM terminal_bookmarks WHERE sandbox_id=${sandboxId} AND terminal_identity=${terminalIdentity}`,
      );
      if (!row || (row.runtime_identity && row.runtime_identity !== runtimeIdentity)) return false;
      this.db.run(
        sql`UPDATE terminal_bookmarks SET runtime_identity=${runtimeIdentity} WHERE sandbox_id=${sandboxId} AND terminal_identity=${terminalIdentity} AND (runtime_identity IS NULL OR runtime_identity=${runtimeIdentity})`,
      );
      return true;
    });
  }
}
