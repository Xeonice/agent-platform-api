import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditRepository } from '../../../apps/api/src/platform/audit/audit.repository';
import { DbAuditRecorder } from '../../../apps/api/src/platform/audit/audit-recorder.impl';
import {
  AuditExportService,
  EXPORT_MAX_BYTES,
} from '../../../apps/api/src/platform/audit/audit-export.service';
import { RuntimeLogWriter } from '../../../apps/api/src/platform/logging/runtime-log-writer';
import { FileRuntimeLogReader } from '../../../apps/api/src/platform/logging/runtime-log-reader';
import { redactLogLine } from '../../../apps/api/src/platform/logging/log-redactor';
import { currentDatabase } from '../../support/sqlite';
import { DIAGNOSE_CHECK_IDS } from '@platform/contracts';
import { DiagnosticsService } from '../../../apps/api/src/platform/system/diagnostics/diagnostics.service';
import { DiagnosticSnapshotService } from '../../../apps/api/src/platform/audit/diagnostic-snapshot.service';
import type { DiagnoseCheck } from '../../../apps/api/src/platform/system/diagnostics/checks/check.types';

const databases: ReturnType<typeof currentDatabase>[] = [];
const temporary: string[] = [];
const now = new Date('2026-10-05T12:00:00.000Z');
function scenario() {
  const database = currentDatabase();
  databases.push(database);
  return { ...database, repo: new AuditRepository(database.db) };
}
afterEach(async () => {
  databases.splice(0).forEach(({ sqlite }) => sqlite.close());
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function contents(service: AuditExportService) {
  const bundle = await service.pack();
  const directory = await mkdtemp(join(tmpdir(), 'acceptance-audit-unpack-'));
  temporary.push(directory);
  try {
    await promisify(execFile)('tar', ['-xzf', bundle.path, '-C', directory]);
    return { directory, bytes: (await stat(bundle.path)).size };
  } finally {
    await bundle.dispose();
  }
}

describe('AC-AUD-002/003/006/008 · current-schema audit evidence', () => {
  it('combines category, inclusive time, warn/error, task artifacts and seq cursors without offset or read writes', () => {
    const s = scenario();
    const insert = (
      offset: number,
      severity: 'info' | 'warn' | 'error',
      category: 'sandbox' | 'project',
      subjectType: string,
      subjectId: string,
      detail: Record<string, string> = {},
    ) =>
      s.repo.insert({
        at: new Date(now.getTime() + offset),
        category,
        type: 'actual.event',
        severity,
        actor: 'system',
        summary: 'actual',
        subjectType,
        subjectId,
        detail,
      });
    insert(-3000, 'warn', 'sandbox', 'sandbox', 'task-a');
    insert(-2000, 'info', 'sandbox', 'sandbox', 'task-a');
    insert(-1000, 'error', 'sandbox', 'retained_volume', 'artifact-a', { sandboxId: 'task-a' });
    insert(0, 'error', 'project', 'project', 'project-a');
    insert(1000, 'error', 'sandbox', 'sandbox', 'task-b');
    const before = s.sqlite.prepare('SELECT total_changes() AS n').get();
    const result = s.repo.list({
      category: 'sandbox',
      severity: ['warn', 'error'],
      subjectId: 'task-a',
      from: new Date(now.getTime() - 3000),
      to: now,
      limit: 1,
    });
    expect(result.items.map((row) => row.seq)).toEqual([3]);
    expect(result.hasMore).toBe(true);
    expect(
      s.repo.list({ subjectId: 'task-a', before: 3, limit: 10 }).items.map((row) => row.seq),
    ).toEqual([2, 1]);
    expect(s.repo.list({ since: 1, limit: 2 }).items.map((row) => row.seq)).toEqual([5, 4]);
    expect(s.repo.list({ since: 1, limit: 2 }).hasMore).toBe(true);
    expect(s.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it('exports the real window with a missing runtime facility declared, preserves task history, and never exports recorded credential plaintext', async () => {
    const s = scenario();
    const token = 'sk-ant-oat01-acceptance-secret-123456';
    const recorder = new DbAuditRecorder(s.repo, { now: () => now });
    recorder.record({
      category: 'credential',
      type: 'credential.actual-operation',
      actor: 'system',
      summary: `Authorization: Bearer ${token}`,
      detail: { access_token: token, env: { PRIVATE_KEY: token }, harmless: 'visible' },
    });
    s.repo.insert({
      at: new Date(now.getTime() - 25 * 3600000),
      category: 'system',
      type: 'old',
      actor: 'system',
      summary: 'outside-window',
    });
    const bundle = await contents(new AuditExportService(s.repo, { now: () => now }));
    const audit = await readFile(join(bundle.directory, 'audit.jsonl'), 'utf8');
    const range = await readFile(join(bundle.directory, 'export-range.json'), 'utf8');
    expect(audit).not.toContain(token);
    expect(audit).not.toContain('outside-window');
    expect(audit).toContain('visible');
    expect(range).toContain('RUNTIME_LOG_READER 未注册');
    await expect(stat(join(bundle.directory, 'runtime.log'))).rejects.toThrow();
    expect(await readFile(join(bundle.directory, 'diagnose.json'), 'utf8')).toContain('checks');
    expect(s.repo.count()).toBe(2);
  });

  it('caps the actual file-reader byte budget at the newest complete lines and exports desensitized runtime text', async () => {
    const s = scenario();
    const directory = await mkdtemp(join(tmpdir(), 'acceptance-runtime-log-'));
    temporary.push(directory);
    const writer = new RuntimeLogWriter({ dir: directory, maxBytes: 1024, maxFiles: 2 });
    const token = 'sk-ant-oat01-file-secret-123456';
    writer.write(
      redactLogLine(
        `${now.toISOString()} INFO [AioSandboxProvider] Authorization: Bearer ${token}`,
      ),
    );
    writer.write(`${now.toISOString()} INFO [AioSandboxProvider] latest-observation`);
    await writer.close();
    const reader = new FileRuntimeLogReader(writer);
    const stream = reader.read({ maxBytes: 90, from: new Date(now.getTime() - 1), to: now });
    let text = '';
    if (stream) for await (const chunk of stream) text += String(chunk);
    expect(text).toContain('latest-observation');
    expect(text).not.toContain(token);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(90);
    const bundle = await contents(new AuditExportService(s.repo, { now: () => now }, reader));
    expect(await readFile(join(bundle.directory, 'runtime.log'), 'utf8')).not.toContain(token);
    expect(bundle.bytes).toBeLessThan(EXPORT_MAX_BYTES);
  });

  it('exports a genuine interrupted diagnostic round with returned evidence, omitted IDs, and redacted nested credentials', async () => {
    const s = scenario();
    const snapshots = new DiagnosticSnapshotService();
    const abort = new AbortController();
    const checks: DiagnoseCheck[] = DIAGNOSE_CHECK_IDS.map((id) => ({
      id,
      label: id,
      run: async () => ({
        status: 'info',
        headline: 'actual observed result',
        detail: { access_token: 'never-export-this-secret' },
      }),
    }));
    const service = new DiagnosticsService(
      checks,
      new DbAuditRecorder(s.repo, { now: () => now }),
      { now: () => now },
      snapshots,
    );
    await service.run((frame) => {
      if (frame.event === 'check') abort.abort();
    }, abort.signal);
    const bundle = await contents(
      new AuditExportService(s.repo, { now: () => now }, undefined, snapshots),
    );
    const serialized = await readFile(join(bundle.directory, 'diagnose.json'), 'utf8');
    const snapshot = JSON.parse(serialized);
    expect(snapshot.diagnostics.phase).toBe('aborted');
    expect(snapshot.checks).toHaveLength(1);
    expect(snapshot.checks[0].headline).toBe('actual observed result');
    expect(snapshot.checksNotReturned).toHaveLength(DIAGNOSE_CHECK_IDS.length - 1);
    expect(serialized).not.toContain('never-export-this-secret');
    expect(s.repo.count()).toBe(0);
    await service.run(() => undefined, new AbortController().signal);
    expect(snapshots.latest()?.phase).toBe('completed');
    expect(snapshots.latest()?.checks).toHaveLength(DIAGNOSE_CHECK_IDS.length);
  });

  it('declares actual runtime truncation below the byte boundary after dropping a partial line, without treating an empty rotation as truncation', async () => {
    const s = scenario();
    const directory = await mkdtemp(join(tmpdir(), 'acceptance-runtime-budget-'));
    temporary.push(directory);
    const writer = new RuntimeLogWriter({ dir: directory, maxFiles: 2 });
    await writer.close();
    const budget = Math.floor(EXPORT_MAX_BYTES * 0.6);
    const line = `${now.toISOString()} INFO ${'x'.repeat(1011)}\n`;
    await writeFile(
      writer.currentPath,
      `${line.repeat(Math.ceil(EXPORT_MAX_BYTES / Buffer.byteLength(line)) + 2)}${now.toISOString()} INFO latest-observation\n`,
    );
    const reader = new FileRuntimeLogReader(writer);
    expect((await stat(writer.currentPath)).size).toBeGreaterThan(EXPORT_MAX_BYTES);
    const bundle = await contents(new AuditExportService(s.repo, { now: () => now }, reader));
    const range = JSON.parse(await readFile(join(bundle.directory, 'export-range.json'), 'utf8'));
    expect(range.runtimeLog.truncated).toBe(true);
    expect(range.runtimeLog.bytes).toBeLessThan(budget);
    expect(
      (await readFile(join(bundle.directory, 'runtime.log'), 'utf8')).endsWith(
        'latest-observation\n',
      ),
    ).toBe(true);
    expect(bundle.bytes).toBeLessThan(EXPORT_MAX_BYTES);
    await writeFile(writer.currentPath, '');
    await writeFile(writer.rotatedPath(1), `${now.toISOString()} INFO only-line\n`);
    const small = reader.read({ maxBytes: 1024 });
    expect(small?.truncated).toBe(false);
    if (small)
      for await (const _chunk of small) {
        /* drain the actual read */
      }
  }, 15_000);

  it('keeps audit and diagnosis available when a real runtime read stream fails asynchronously', async () => {
    const s = scenario();
    const directory = await mkdtemp(join(tmpdir(), 'acceptance-audit-io-'));
    temporary.push(directory);
    const bundle = await contents(
      new AuditExportService(
        s.repo,
        { now: () => now },
        {
          read: () => createReadStream(join(directory, 'actually-missing.log')),
        },
      ),
    );
    const range = JSON.parse(await readFile(join(bundle.directory, 'export-range.json'), 'utf8'));
    expect(range.runtimeLog.included).toBe(false);
    expect(range.runtimeLog.omittedReason).toContain('读取运行日志失败');
    await expect(stat(join(bundle.directory, 'runtime.log'))).rejects.toThrow();
    expect(await readFile(join(bundle.directory, 'audit.jsonl'), 'utf8')).toBe('');
    const snapshot = JSON.parse(await readFile(join(bundle.directory, 'diagnose.json'), 'utf8'));
    expect(snapshot.checks).toEqual([]);
    expect(snapshot.checksUnavailable).toContain('尚未运行诊断');
    expect(snapshot.platform).toEqual(expect.objectContaining({ node: process.version }));
    expect(snapshot.platform).toHaveProperty('version');
    expect(snapshot.platform).toHaveProperty('commit');
    expect(snapshot.platform).toHaveProperty('builtAt');
  });
});
