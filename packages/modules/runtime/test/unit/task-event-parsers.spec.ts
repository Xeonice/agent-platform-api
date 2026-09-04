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

/**
 * ⚠️ THE GOLDEN PARSE MUST HAPPEN **INSIDE** THE `it`, NOT IN THE `describe` BODY
 * (29 §3.5.2c 的测量盲区).
 *
 * These two used to read `const events = codex.parseOutput(…)` at the top of their
 * `describe`. A `describe` callback runs during COLLECTION — before any test starts —
 * while Stryker's `perTest` coverage only activates a mutant once the test it is
 * attributed to has begun. So the events every assertion below inspects were produced
 * by the UNMUTATED parser: 变异体照跑，断言照绿。Measured: `codex.output-parser.ts`
 * sat at 48.0% with 103 survivors while these assertions were nominally covering it.
 *
 * Parsing per test costs microseconds (a few JSONL lines) and is what makes the
 * assertions real.
 */
const codexSuccess = (): RuntimeEvent[] =>
  codex.parseOutput(read('codex/v0.43.1/task-success.stdout.jsonl'));
const claudeSuccess = (): RuntimeEvent[] =>
  claude.parseOutput(read('claude-code/v1.8.0/task-success.stdout.jsonl'));

/** One JSONL line, the shape the job plane really hands `parseOutput`. */
const line = (o: unknown): Buffer => Buffer.from(`${JSON.stringify(o)}\n`, 'utf8');

describe('codex parseOutput (golden, success path)', () => {
  it('maps thread.started to session-started carrying the resume reference', () => {
    const events = codexSuccess();
    expect(events[0]).toEqual({
      type: 'session-started',
      timestamp: '',
      data: { ref: '01996b8f-4d21-7a0c-9f3e-2c5d8a1b7e40' },
    });
  });

  it('emits both halves of BOTH tool calls, and the agent’s prose as its own member', () => {
    const events = codexSuccess();
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
    const events = codexSuccess();
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
    const events = codexSuccess();
    expect(dataOf(events[3])).toEqual({
      status: 'started',
      id: 'item_1',
      name: 'file_change',
      input: { changes: [{ path: 'summary.md', kind: 'add' }] },
    });
    expect(dataOf(events[4])).toEqual({ status: 'completed', id: 'item_1' });
  });

  it('agent prose lands on `agent-message`, NOT on `stdout-chunk`', () => {
    const events = codexSuccess();
    expect(events[5]).toEqual({
      type: 'agent-message',
      timestamp: '',
      data: { text: 'Wrote summary.md and counted 2 lines.' },
    });
    expect(types(events)).not.toContain('stdout-chunk');
  });

  it('task-complete carries an EMPTY payload — the exit code is on the /tasks exit frame', () => {
    const events = codexSuccess();
    expect(events[6]).toEqual({ type: 'task-complete', timestamp: '', data: {} });
  });

  it('leaves `timestamp` for the application layer to stamp (no Clock here, 01 §3)', () => {
    const events = codexSuccess();
    expect(events.every((e) => e.timestamp === '')).toBe(true);
  });
});

describe('codex parseOutput (golden, failure path)', () => {
  it('turn.failed becomes an error event carrying a flattened message', () => {
    const events = codex.parseOutput(read('codex/v0.43.1/task-failure.stdout.jsonl'));
    expect(types(events)).toEqual(['session-started', 'error']);
    // 整条断言而不只是 message —— 失败路径的 `timestamp` 同样归应用层盖章（01 §3），
    // 只断言 message 会让一个在这里编时间的实现照绿。
    expect(events[1]).toEqual({
      type: 'error',
      timestamp: '',
      data: { message: 'usage_limit_reached: You have hit your usage limit.' },
    });
  });

  it('a resume of a dead reference writes NOTHING to stdout — the fact lives on stderr', () => {
    // The stderr fixture is text, not JSONL; feeding it to the parser must not
    // manufacture events. This is why stdout/stderr stay separated (04 §2.6 裁决 3).
    expect(codex.parseOutput(Buffer.from(''))).toEqual([]);
    expect(codex.parseOutput(read('codex/v0.43.1/task-resume-missing.stderr.txt'))).toEqual([]);
  });
});

describe('claude parseOutput (golden, success path)', () => {
  it('maps system/init to session-started and drops system/thinking_tokens', () => {
    const events = claudeSuccess();
    expect(events[0]).toEqual({
      type: 'session-started',
      timestamp: '',
      data: { ref: 'c1f0e6b2-9d3a-4f77-8a11-2b6c5e90d4aa' },
    });
  });

  it('splits an assistant message into its blocks, dropping `thinking`', () => {
    const events = claudeSuccess();
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
    const events = claudeSuccess();
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

/**
 * codex's event MAP, branch by branch (04 §3 ★4).
 *
 * The golden fixtures above replay the ONE measured success run and the ONE measured
 * failure run, so they exercise the happy shape of five event types and nothing else.
 * Everything below is a decision the mapper makes that the two recordings never reach —
 * and each one is a documented rule in `codex.output-parser.ts`, not a shape invented
 * here: an unmeasured item type is DROPPED rather than force-fitted, `name`/`input`
 * ride the started half only, and a field the CLI did not report stays ABSENT instead
 * of degrading to `0` / `''`.
 */
describe('codex event mapping — the branches the two golden runs never reach', () => {
  it('a thread.started with NO id yields nothing — a resume that did not attach must not look like it did', () => {
    // The id is what lets the platform CONFIRM a `resume` really attached. Emitting a
    // `session-started` carrying '' would persist an empty sessionRef as the next
    // turn's `resumeFrom`, i.e. silently start a fresh conversation every time.
    expect(codex.parseOutput(line({ type: 'thread.started' }))).toEqual([]);
    expect(codex.parseOutput(line({ type: 'thread.started', thread_id: '' }))).toEqual([]);
    // …and a non-string id is the same fact, not a stringified one.
    expect(codex.parseOutput(line({ type: 'thread.started', thread_id: 42 }))).toEqual([]);
  });

  it('turn.started and any unmeasured top-level type are DROPPED, not guessed at', () => {
    expect(codex.parseOutput(line({ type: 'turn.started' }))).toEqual([]);
    expect(codex.parseOutput(line({ type: 'thread.finished' }))).toEqual([]);
    expect(codex.parseOutput(line({ nothing: 'here' }))).toEqual([]);
  });

  it('an agent_message arriving as the STARTED half is dropped — a started half would be an empty bubble', () => {
    const started = codex.parseOutput(
      line({ type: 'item.started', item: { id: 'item_2', type: 'agent_message', text: 'hi' } }),
    );
    expect(started).toEqual([]);
    // the completed half is the one that carries the text (and it is the only one).
    const completed = codex.parseOutput(
      line({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'hi' } }),
    );
    expect(completed).toEqual([{ type: 'agent-message', timestamp: '', data: { text: 'hi' } }]);
  });

  it('an item type nobody has measured is DROPPED — labelling it `tool-call` would be wrong forever', () => {
    expect(
      codex.parseOutput(line({ type: 'item.completed', item: { id: 'x', type: 'web_search' } })),
    ).toEqual([]);
    // …and an `item` that is not an object at all cannot be mapped either.
    expect(codex.parseOutput(line({ type: 'item.started', item: 'command_execution' }))).toEqual(
      [],
    );
    expect(codex.parseOutput(line({ type: 'item.completed', item: null }))).toEqual([]);
  });

  it('⚠️ an exit code the CLI did not report stays ABSENT — never a synthesised 0', () => {
    // `exitCode` is documented as "a REAL process exit code, or absent. It is NEVER
    // synthesised" (runtime-adapter.contract). A 0 manufactured here would tell every
    // consumer the command SUCCEEDED on the strength of a field the CLI never sent.
    const [event] = codex.parseOutput(
      line({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution' } }),
    );
    // ⚠️ `toStrictEqual`, not `toEqual`: the latter counts an explicit
    // `exitCode: undefined` as equal to no `exitCode` at all, which is exactly the
    // difference this assertion exists to see.
    expect(dataOf(event)).toStrictEqual({ status: 'completed', id: 'item_0' });
    expect('exitCode' in dataOf(event)).toBe(false);
    // a non-numeric exit code is "not reported" too, not `NaN` and not the string.
    const [coerced] = codex.parseOutput(
      line({
        type: 'item.completed',
        item: { id: 'item_0', type: 'command_execution', exit_code: '0' },
      }),
    );
    expect(dataOf(coerced)).toStrictEqual({ status: 'completed', id: 'item_0' });
    expect('exitCode' in dataOf(coerced)).toBe(false);
  });

  it('output is likewise absent rather than empty when the CLI reported none', () => {
    const [event] = codex.parseOutput(
      line({
        type: 'item.completed',
        item: { id: 'item_0', type: 'command_execution', exit_code: 2, aggregated_output: null },
      }),
    );
    // exit code present, output absent — the two travel independently.
    expect(dataOf(event)).toStrictEqual({ status: 'completed', id: 'item_0', exitCode: 2 });
    expect('output' in dataOf(event)).toBe(false);
  });

  it('an id the CLI did not send becomes the empty string, not `undefined` — the halves pair on it', () => {
    const [started] = codex.parseOutput(
      line({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } }),
    );
    expect(dataOf(started)).toEqual({
      status: 'started',
      id: '',
      name: 'command_execution',
      input: { command: 'ls' },
    });
  });

  it('the file_change COMPLETED half carries only status+id — the changes rode the started half', () => {
    const [event] = codex.parseOutput(
      line({
        type: 'item.completed',
        item: { id: 'item_1', type: 'file_change', changes: [{ path: 'a.md', kind: 'add' }] },
      }),
    );
    expect(dataOf(event)).toStrictEqual({ status: 'completed', id: 'item_1' });
    expect('input' in dataOf(event)).toBe(false);
    expect('name' in dataOf(event)).toBe(false);
  });

  it('a bare `error` line becomes an error event, with a stand-in message when it carries none', () => {
    const [withMessage] = codex.parseOutput(line({ type: 'error', message: 'stream closed' }));
    expect(withMessage).toEqual({
      type: 'error',
      timestamp: '',
      data: { message: 'stream closed' },
    });
    const [without] = codex.parseOutput(line({ type: 'error' }));
    // an error with no text is still an error — an empty message would render as a
    // blank failure the user cannot act on.
    expect(dataOf(without).message).toBe('codex error');
  });

  it('turn.failed flattens every shape codex has for `error` into the union’s one field', () => {
    const messageOf = (error: unknown): unknown =>
      dataOf(codex.parseOutput(line({ type: 'turn.failed', error }))[0]).message;
    // both halves → "type: message" (the measured shape, pinned by the golden fixture)
    expect(messageOf({ type: 'usage_limit_reached', message: 'hit the cap' })).toBe(
      'usage_limit_reached: hit the cap',
    );
    // message only → the message alone, NOT ": hit the cap" with an empty prefix
    expect(messageOf({ message: 'hit the cap' })).toBe('hit the cap');
    // type only → the type is the whole story there is
    expect(messageOf({ type: 'usage_limit_reached' })).toBe('usage_limit_reached');
    // a plain string error is used verbatim
    expect(messageOf('boom')).toBe('boom');
    // nothing usable → a stand-in, never an empty message
    expect(messageOf({})).toBe('codex turn failed');
    expect(messageOf(undefined)).toBe('codex turn failed');
    expect(messageOf(null)).toBe('codex turn failed');
  });

  it('a JSON line that is not an OBJECT is dropped, exactly like a non-JSON one', () => {
    // The job plane hands over whole lines, so a non-object line means the CLI wrote
    // something that is not the JSONL it promises — a fact about the CLI, not
    // something to paper over by mapping `null`/`[]`/`7` onto an event.
    expect(codex.parseOutput(Buffer.from('[{"type":"turn.completed"}]\n'))).toEqual([]);
    expect(codex.parseOutput(Buffer.from('null\n'))).toEqual([]);
    expect(codex.parseOutput(Buffer.from('7\n'))).toEqual([]);
    expect(codex.parseOutput(Buffer.from('"turn.completed"\n'))).toEqual([]);
  });

  it('blank and whitespace-only lines are skipped without disturbing the rest of the chunk', () => {
    const chunk = Buffer.concat([
      Buffer.from('\n   \n\t\n'),
      line({ type: 'turn.completed' }),
      Buffer.from('\n'),
    ]);
    expect(codex.parseOutput(chunk)).toEqual([{ type: 'task-complete', timestamp: '', data: {} }]);
  });
});
