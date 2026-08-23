import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { RuntimeEvent } from '@platform/contracts';
import { CodexAdapter } from '../../src/infrastructure/adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../../src/infrastructure/adapters/claude-code/claude-code.adapter';

/**
 * Golden replay of the HEADLESS TASK event stream (25 §2.3 CLI-AUTH-PARSE's sibling
 * for the run half; 04 §3 ★4).
 *
 * The fixtures are the event surfaces measured in 04 §3 ★4 against real credentials —
 * codex's `thread.started` / `item.completed{agent_message,command_execution,
 * file_change}` / `turn.completed|turn.failed`, and claude's `system/init` /
 * `assistant` / `user` / `result`. Both SUCCESS and FAILURE paths are covered,
 * because they differ in more than a flag: on failure codex writes ZERO bytes to
 * stdout and puts everything on stderr, and claude emits `subtype:"success"` together
 * with `is_error:true`.
 *
 * These run through `adapter.parseOutput` — the real entry point the job plane calls —
 * rather than the parser functions directly, so a wiring mistake in the adapter is
 * caught here too.
 */
const FIX = resolve(__dirname, '../fixtures/cli-output');
const read = (p: string): Buffer => readFileSync(resolve(FIX, p));

const codex = new CodexAdapter();
const claude = new ClaudeCodeAdapter();

const types = (events: RuntimeEvent[]): string[] => events.map((e) => e.type);
const dataOf = (e: RuntimeEvent): Record<string, unknown> => e.data as Record<string, unknown>;

describe('codex parseOutput (golden, success path)', () => {
  const events = codex.parseOutput(read('codex/v0.43.1/task-success.stdout.jsonl'));

  it('maps thread.started to session-started carrying the resume reference', () => {
    expect(events[0]).toEqual({
      type: 'session-started',
      timestamp: '',
      data: { ref: '01996b8f-4d21-7a0c-9f3e-2c5d8a1b7e40' },
    });
  });

  it('emits both halves of BOTH tool calls, and the agent’s prose as its own member', () => {
    expect(types(events)).toEqual([
      'session-started',
      'tool-call', // item.started  (command_execution) → status 'started'
      'tool-call', // item.completed(command_execution) → status 'completed'
      'tool-call', // item.started  (file_change)
      'tool-call', // item.completed(file_change)
      'agent-message',
      'task-complete',
    ]);
  });

  it('`name` and `input` ride the STARTED half; output and exit code ride COMPLETED', () => {
    const started = dataOf(events[1]);
    const completed = dataOf(events[2]);
    expect(started).toEqual({
      status: 'started',
      id: 'item_0',
      // the KIND of tool, matching claude's `tool_use.name` axis; the command is input.
      name: 'command_execution',
      input: { command: 'cat notes.txt' },
    });
    expect(completed).toEqual({
      status: 'completed',
      id: 'item_0',
      exitCode: 0,
      output: 'remember 4271\n',
    });
    // the two halves are paired by id and by nothing else.
    expect(completed.id).toBe(started.id);
    expect('name' in completed).toBe(false);
  });

  it('a file_change reports its changed paths as the STARTED half’s input', () => {
    expect(dataOf(events[3])).toEqual({
      status: 'started',
      id: 'item_1',
      name: 'file_change',
      input: { changes: [{ path: 'summary.md', kind: 'add' }] },
    });
    expect(dataOf(events[4])).toEqual({ status: 'completed', id: 'item_1' });
  });

  it('agent prose lands on `agent-message`, NOT on `stdout-chunk`', () => {
    expect(events[5]).toEqual({
      type: 'agent-message',
      timestamp: '',
      data: { text: 'Wrote summary.md and counted 2 lines.' },
    });
    expect(types(events)).not.toContain('stdout-chunk');
  });

  it('task-complete carries an EMPTY payload — the exit code is on the /tasks exit frame', () => {
    expect(events[6]).toEqual({ type: 'task-complete', timestamp: '', data: {} });
  });

  it('leaves `timestamp` for the application layer to stamp (no Clock here, 01 §3)', () => {
    expect(events.every((e) => e.timestamp === '')).toBe(true);
  });
});

describe('codex parseOutput (golden, failure path)', () => {
  it('turn.failed becomes an error event carrying a flattened message', () => {
    const events = codex.parseOutput(read('codex/v0.43.1/task-failure.stdout.jsonl'));
    expect(types(events)).toEqual(['session-started', 'error']);
    expect(dataOf(events[1]).message).toBe('usage_limit_reached: You have hit your usage limit.');
  });

  it('a resume of a dead reference writes NOTHING to stdout — the fact lives on stderr', () => {
    // The stderr fixture is text, not JSONL; feeding it to the parser must not
    // manufacture events. This is why stdout/stderr stay separated (04 §2.6 裁决 3).
    expect(codex.parseOutput(Buffer.from(''))).toEqual([]);
    expect(codex.parseOutput(read('codex/v0.43.1/task-resume-missing.stderr.txt'))).toEqual([]);
  });
});

describe('claude parseOutput (golden, success path)', () => {
  const events = claude.parseOutput(read('claude-code/v1.8.0/task-success.stdout.jsonl'));

  it('maps system/init to session-started and drops system/thinking_tokens', () => {
    expect(events[0]).toEqual({
      type: 'session-started',
      timestamp: '',
      data: { ref: 'c1f0e6b2-9d3a-4f77-8a11-2b6c5e90d4aa' },
    });
  });

  it('splits an assistant message into its blocks, dropping `thinking`', () => {
    expect(types(events)).toEqual([
      'session-started',
      'agent-message',
      'tool-call',
      'tool-call',
      'agent-message',
      'task-complete',
    ]);
  });

  it('correlates the tool RESULT (a later `user` message) by id — and carries NO name', () => {
    const call = dataOf(events[2]);
    const result = dataOf(events[3]);
    expect(call).toEqual({
      status: 'started',
      id: 'toolu_01A',
      name: 'Read',
      input: { file_path: '/workspace/notes.txt' },
    });
    // codex carries the output on the call itself; claude does NOT — the id is the only
    // link, which is exactly why the two parsers cannot be one (04 §3 ★4).
    expect(result).toEqual({
      status: 'completed',
      id: 'toolu_01A',
      output: 'remember 4271\n',
    });
    // the name is not knowable here WITHOUT STATE, and state would make a replay differ
    // from the live parse — so the field is absent rather than an empty lie.
    expect('name' in result).toBe(false);
  });

  it('claude’s tool-failure boolean travels as `isError`, and NEVER as a fake exitCode', () => {
    const [failed] = claude.parseOutput(
      Buffer.from(
        `${JSON.stringify({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_9', content: 'nope', is_error: true },
            ],
          },
        })}\n`,
      ),
    );
    expect(dataOf(failed)).toEqual({
      status: 'completed',
      id: 'toolu_9',
      isError: true,
      output: 'nope',
    });
    // ⚠️ THE POINT: a synthesised 1 here would sit in the SAME field codex fills with a
    // MEASURED exit code, and no consumer could tell the two apart.
    expect('exitCode' in dataOf(failed)).toBe(false);
  });

  it('codex fills `exitCode` (measured) and claude fills `isError` — neither impersonates the other', () => {
    const codexCompleted = dataOf(
      codex.parseOutput(read('codex/v0.43.1/task-success.stdout.jsonl'))[2],
    );
    expect(codexCompleted.exitCode).toBe(0);
    expect('isError' in codexCompleted).toBe(false);

    const claudeCompleted = dataOf(
      claude.parseOutput(read('claude-code/v1.8.0/task-success.stdout.jsonl'))[3],
    );
    expect('exitCode' in claudeCompleted).toBe(false);
    // a result with no failure reported carries neither field — absent means
    // "nothing was reported", not "it succeeded".
    expect('isError' in claudeCompleted).toBe(false);
  });
});

describe('claude parseOutput (golden, failure path)', () => {
  it('judges success by `is_error` ONLY — subtype:"success" + is_error:true is a FAILURE', () => {
    const events = claude.parseOutput(read('claude-code/v1.8.0/task-failure.stdout.jsonl'));
    const last = events[events.length - 1];
    expect(last.type).toBe('error');
    expect(dataOf(last).message).toBe('Credit balance is too low to run this request.');
  });

  it('a resume of a dead reference is a loud error on stdout', () => {
    const events = claude.parseOutput(read('claude-code/v1.8.0/task-resume-missing.stdout.jsonl'));
    expect(types(events)).toEqual(['error']);
    expect(String(dataOf(events[0]).message)).toContain('No conversation found');
  });
});

describe('parseOutput robustness', () => {
  it('drops a non-JSON line instead of guessing at it', () => {
    expect(codex.parseOutput(Buffer.from('not json at all\n'))).toEqual([]);
    expect(claude.parseOutput(Buffer.from('not json at all\n'))).toEqual([]);
  });

  it('is stateless: the same bytes replayed later produce the same events', () => {
    const bytes = read('codex/v0.43.1/task-success.stdout.jsonl');
    expect(codex.parseOutput(bytes)).toEqual(codex.parseOutput(bytes));
  });

  it('splitting the SAME stream on line boundaries yields the same total sequence', () => {
    // The job plane guarantees whole lines, so chunking must not change the result —
    // this is what keeps `fromSeq` replay off the persisted raw log dense and stable.
    const text = read('claude-code/v1.8.0/task-success.stdout.jsonl').toString('utf8');
    const lines = text.split('\n').filter((l) => l !== '');
    const perLine = lines.flatMap((l) => claude.parseOutput(Buffer.from(`${l}\n`)));
    expect(perLine).toEqual(claude.parseOutput(Buffer.from(text)));
  });
});
