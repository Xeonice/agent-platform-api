import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsTaskLogStore } from '../../src/infrastructure/tasks/fs-task-log.store';

/**
 * The raw-log store on a REAL filesystem. Two of its behaviours are load-bearing far
 * away from this file and are invisible in a happy-path test:
 *
 *   ① `truncateStdout` is the other half of `agent_tasks.stdout_bytes`. The bytes are
 *      appended BEFORE the cursor is persisted, so a crash between the two leaves a log
 *      longer than the cursor admits and the resume rewrites those bytes — duplicate
 *      lines, a replay that outruns the live stream, and a permanently shifted `seq`.
 *   ② `streamStdoutLines` must distinguish "no log yet" (normal) from "the read FAILED"
 *      (not). Reporting a failure as an empty replay makes the gateway answer
 *      `caught_up{firstSeq: fromSeq+1}` — "you are up to date" — which is precisely the
 *      lie `firstSeq` was introduced to make detectable.
 */
let root: string;
let restore: string | undefined;
let store: FsTaskLogStore;

beforeEach(async () => {
  root = await mkdtemp(resolve(tmpdir(), 'task-logs-'));
  restore = process.env.DATA_ROOT;
  process.env.DATA_ROOT = root;
  store = new FsTaskLogStore();
});

afterEach(async () => {
  if (restore === undefined) delete process.env.DATA_ROOT;
  else process.env.DATA_ROOT = restore;
  await rm(root, { recursive: true, force: true });
});

async function lines(taskId: string): Promise<string[]> {
  const out: string[] = [];
  for await (const line of store.streamStdoutLines(taskId)) out.push(line);
  return out;
}

describe('FsTaskLogStore — stdout is the replay source, so it must be exact', () => {
  it('appends verbatim and streams the lines back in order', async () => {
    await store.prepare('t1');
    await store.appendStdout('t1', '{"a":1}\n{"a":2}\n');
    await store.appendStdout('t1', '{"a":3}\n');
    await store.flush('t1');
    expect(await lines('t1')).toEqual(['{"a":1}', '{"a":2}', '{"a":3}']);
    // byte-for-byte: the CLI's own JSONL, not a re-serialisation of it.
    expect(await readFile(store.stdoutPath('t1'), 'utf8')).toBe('{"a":1}\n{"a":2}\n{"a":3}\n');
  });

  it('a log that does not exist yet reads as EMPTY — subscribing early is normal', async () => {
    await store.prepare('t2');
    expect(await lines('t2')).toEqual([]);
  });

  it('a READ FAILURE throws instead of masquerading as an empty replay', async () => {
    // A directory where the log should be: `stat` succeeds, the read does not. Any
    // catch-all here would report this as "no events", i.e. as `caught_up`.
    const dir = await store.prepare('t3');
    await mkdir(resolve(dir, 'stdout.jsonl'));
    await expect(lines('t3')).rejects.toThrow();
  });

  it('truncateStdout rolls the log back to the durable length', async () => {
    await store.prepare('t4');
    await store.appendStdout('t4', 'one\ntwo\n');
    await store.flush('t4');
    // "one\n" was durable when the cursor was written; "two\n" landed after it.
    await store.truncateStdout('t4', Buffer.byteLength('one\n', 'utf8'));
    expect(await lines('t4')).toEqual(['one']);

    // …and re-reading from the old cursor writes those bytes exactly once.
    await store.appendStdout('t4', 'two\n');
    await store.flush('t4');
    expect(await lines('t4')).toEqual(['one', 'two']);
  });

  it('truncateStdout never EXTENDS a shorter log, and tolerates a missing one', async () => {
    await store.prepare('t5');
    await store.appendStdout('t5', 'x\n');
    await store.flush('t5');
    await store.truncateStdout('t5', 9_999);
    expect(await readFile(store.stdoutPath('t5'), 'utf8')).toBe('x\n');
    // a task that crashed before its first chunk has no file at all — not an error, and
    // not something to paper over by creating an empty one.
    await store.prepare('t6');
    await expect(store.truncateStdout('t6', 0)).resolves.toBeUndefined();
    expect(await lines('t6')).toEqual([]);
  });

  it('a UTF-8 sequence split across two chunks survives the byte accounting', async () => {
    // `stdout_bytes` counts BYTES while the chunks are strings; a multi-byte character
    // is where a length-vs-byteLength slip would show up as a corrupted resume.
    await store.prepare('t7');
    const line = '{"text":"中文测试"}\n';
    await store.appendStdout('t7', line);
    await store.flush('t7');
    const bytes = Buffer.byteLength(line, 'utf8');
    await store.truncateStdout('t7', bytes);
    expect(await lines('t7')).toEqual([line.trimEnd()]);
  });

  it('release() drops the per-task append chain — it used to grow forever', async () => {
    await store.prepare('t8');
    await store.appendStdout('t8', 'a\n');
    await store.release('t8');
    // the bytes stay on disk; only the in-memory ordering promise is forgotten.
    expect(await lines('t8')).toEqual(['a']);
  });

  it('stderr is a SEPARATE file, wrapped so it stays valid JSONL', async () => {
    await store.prepare('t9');
    await store.appendStderr('t9', 'a traceback\nwith a second line\n');
    await store.flush('t9');
    const raw = await readFile(store.stderrPath('t9'), 'utf8');
    expect(JSON.parse(raw.trim())).toEqual({ chunk: 'a traceback\nwith a second line\n' });
    // merging the two is what turns clean JSONL into "parseable + garbage" lines.
    expect(await lines('t9')).toEqual([]);
  });

  it('appends stay ORDERED even when the callers do not await each other', async () => {
    await store.prepare('t10');
    const writes = ['1\n', '2\n', '3\n', '4\n'].map((c) => store.appendStdout('t10', c));
    await Promise.all(writes);
    // out-of-order stdout would renumber every replayed event.
    expect(await lines('t10')).toEqual(['1', '2', '3', '4']);
  });
});
