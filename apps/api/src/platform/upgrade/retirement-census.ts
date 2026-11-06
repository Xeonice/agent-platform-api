import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord } from '@platform/shared-kernel';

/** Process-local observations only. An abort/response close cannot end a
 * still-running Promise. The caller must release work in that Promise's finally. */
export class RetirementWorkTracker {
  private readonly counts = { http: 0, ws: 0, work: 0 };
  begin(kind: keyof RetirementWorkTracker['counts']): () => void {
    this.counts[kind]++;
    let closed = false;
    return () => {
      if (!closed) {
        closed = true;
        this.counts[kind]--;
      }
    };
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    const close = this.begin('work');
    try {
      return await work();
    } finally {
      close();
    }
  }
  request(req: IncomingMessage, res: ServerResponse): void {
    const done = this.begin('http');
    res.once('close', done);
    res.once('finish', done);
    req.once('error', done);
  }
  snapshot(): { http: number; ws: number; work: number } {
    return { ...this.counts };
  }
}

interface ReadonlySqlite {
  readonly readonly: boolean;
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/** A fixed bounded projection of actual participant rows, never integrity
 * scans, evidence bodies, Owner calls or arbitrary caller-supplied SQL. */
export function preparedRetirementRows(
  sqlite: ReadonlySqlite,
  target: { startIdentity: string; artifactDigest: string; generation: number },
): { handoff: number | null; recovery: number | null } {
  function count(table: 'coordinator_handoffs' | 'coordinator_recoveries'): number | null {
    try {
      const rows = sqlite
        .prepare(`SELECT candidate,source_generation FROM ${table} LIMIT 129`)
        .all();
      if (rows.length > 128) return null;
      let references = 0;
      for (const raw of rows) {
        if (!raw || typeof raw !== 'object' || !('candidate' in raw)) return null;
        const candidate = raw.candidate;
        if (typeof candidate !== 'string' || Buffer.byteLength(candidate) > 65536) return null;
        const parsed: unknown = JSON.parse(candidate);
        if (!isRecord(parsed)) return null;
        const value = parsed;
        if (typeof value.startIdentity !== 'string' || typeof value.artifactDigest !== 'string')
          return null;
        if (
          (value.startIdentity === target.startIdentity &&
            value.artifactDigest === target.artifactDigest) ||
          ('source_generation' in raw &&
            target.generation > 0 &&
            raw.source_generation === target.generation)
        )
          references++;
      }
      return references;
    } catch {
      return null;
    }
  }
  return { handoff: count('coordinator_handoffs'), recovery: count('coordinator_recoveries') };
}
