import { readSqlite } from './read-sqlite';
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE, fromEpochMs, isRecord, type Tx } from '@platform/shared-kernel';
import type {
  JobCompletionObservation,
  JobCompletionReceipt,
  JobCompletionReceipts,
} from '../../../domain/ports/job-completion-receipts.port';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  const encoded: unknown = JSON.stringify(value);
  if (typeof encoded !== 'string') throw new Error('JOB_COMPLETION_INVALID_FACT');
  return encoded;
}

export function completedJobHandleDigest(handle: { provider: string; jobId: string }): string {
  return `sha256:${createHash('sha256')
    .update(canonical({ provider: handle.provider, jobId: handle.jobId }))
    .digest('hex')}`;
}

/** Inspector and persistence use the same schema and digest; it is evidence, not authentication. */
export function jobCompletionEvidenceDigest(
  receipt: Omit<JobCompletionReceipt, 'evidenceDigest'>,
): string {
  return `sha256:${createHash('sha256')
    .update(
      canonical({
        schemaVersion: 1,
        source: 'read-job-exited',
        taskId: receipt.taskId,
        sandboxId: receipt.sandboxId,
        provider: receipt.provider,
        jobHandleDigest: receipt.jobHandleDigest,
        cursor: receipt.cursor,
        lastSeq: receipt.lastSeq,
        exitCode: receipt.exitCode,
        exitKind: receipt.exitKind,
        observedAt: receipt.observedAt.getTime(),
      }),
    )
    .digest('hex')}`;
}

interface Row {
  task_id: string;
  sandbox_id: string;
  provider: string;
  job_handle_digest: string;
  cursor: string | null;
  last_seq: number;
  exit_code: number | null;
  exit_kind: JobCompletionReceipt['exitKind'];
  observed_at: number;
  evidence_digest: string;
}
function decode(row: Row): JobCompletionReceipt {
  return {
    taskId: row.task_id,
    sandboxId: row.sandbox_id,
    provider: row.provider,
    jobHandleDigest: row.job_handle_digest,
    cursor: row.cursor,
    lastSeq: row.last_seq,
    exitCode: row.exit_code,
    exitKind: row.exit_kind,
    observedAt: fromEpochMs(row.observed_at),
    evidenceDigest: row.evidence_digest,
  };
}

@Injectable()
export class SqliteJobCompletionReceipts implements JobCompletionReceipts {
  constructor(@Inject(DATABASE) private readonly db: BetterSQLite3Database) {}
  saveObservedSync(_tx: Tx, observation: JobCompletionObservation): JobCompletionReceipt {
    const receipt: JobCompletionReceipt = {
      taskId: observation.taskId,
      sandboxId: observation.sandboxId,
      provider: observation.jobHandle.provider,
      jobHandleDigest: completedJobHandleDigest(observation.jobHandle),
      cursor: observation.cursor,
      lastSeq: observation.lastSeq,
      exitCode: observation.exitCode,
      exitKind: observation.exitKind,
      observedAt: observation.observedAt,
      evidenceDigest: '',
    };
    receipt.evidenceDigest = jobCompletionEvidenceDigest(receipt);
    const existing = this.db.get<Row | undefined>(
      sql`SELECT * FROM agent_task_job_completions WHERE task_id=${receipt.taskId}`,
    );
    if (existing) {
      if (existing.evidence_digest !== receipt.evidenceDigest)
        throw new Error('JOB_COMPLETION_RECEIPT_CONFLICT');
      return decode(existing);
    }
    const task = this.db.get<
      | {
          sandbox_id: string;
          job_handle: string;
          cursor: string | null;
          last_seq: number;
          status: string;
          exit_code: number | null;
          cancel_requested_at: number | null;
        }
      | undefined
    >(
      sql`SELECT sandbox_id,job_handle,cursor,last_seq,status,exit_code,cancel_requested_at FROM agent_tasks WHERE id=${receipt.taskId}`,
    );
    if (
      !task ||
      task.status === 'running' ||
      task.sandbox_id !== receipt.sandboxId ||
      completedJobHandleDigest(decodeJobHandle(task.job_handle)) !== receipt.jobHandleDigest ||
      task.cursor !== receipt.cursor ||
      task.last_seq !== receipt.lastSeq ||
      task.exit_code !== receipt.exitCode ||
      (receipt.exitKind === 'cancelled' &&
        (task.status !== 'killed' || task.cancel_requested_at === null)) ||
      (receipt.exitKind === 'timeout' && task.status !== 'timed_out') ||
      !Number.isSafeInteger(receipt.lastSeq) ||
      receipt.lastSeq < 0 ||
      !Number.isSafeInteger(receipt.observedAt.getTime())
    )
      throw new Error('JOB_COMPLETION_TASK_MISMATCH');
    this.db
      .run(sql`INSERT INTO agent_task_job_completions(task_id,sandbox_id,provider,job_handle_digest,cursor,last_seq,exit_code,exit_kind,observed_at,evidence_digest)
      VALUES(${receipt.taskId},${receipt.sandboxId},${receipt.provider},${receipt.jobHandleDigest},${receipt.cursor},${receipt.lastSeq},${receipt.exitCode},${receipt.exitKind},${receipt.observedAt.getTime()},${receipt.evidenceDigest})`);
    return receipt;
  }
  find(taskId: string): Promise<JobCompletionReceipt | null> {
    return readSqlite(() => {
      const row = this.db.get<Row | undefined>(
        sql`SELECT * FROM agent_task_job_completions WHERE task_id=${taskId}`,
      );
      if (!row) return null;
      const receipt = decode(row);
      if (jobCompletionEvidenceDigest(receipt) !== receipt.evidenceDigest)
        throw new Error('JOB_COMPLETION_RECEIPT_CORRUPT');
      return receipt;
    });
  }
}

function decodeJobHandle(raw: string): JobCompletionObservation['jobHandle'] {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || typeof value.provider !== 'string' || typeof value.jobId !== 'string')
    throw new Error('JOB_COMPLETION_INVALID_HANDLE');
  return { provider: value.provider, jobId: value.jobId };
}
