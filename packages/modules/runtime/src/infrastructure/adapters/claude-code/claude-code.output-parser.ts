import type { RuntimeEvent } from '@platform/contracts';
import { extractOsc8Urls, stripAnsi } from '../ansi.util';

/**
 * Claude `setup-token` output parser (docs/backend/05 §1 ★1, §3). TWO fragile bits,
 * both golden-fixture tested (25 §2.3):
 *   1. the authorization URL is hidden in an OSC-8 escape (the VISIBLE text is
 *      pty-truncated) → parse OSC-8, never `grep https://`.
 *   2. the 1-year token (`sk-ant-oat01-…`) is printed to stdout and FOLDED across
 *      lines by the pty → rejoin the charset-only fold fragments, strip whitespace.
 * Pure — no IO. The caller validates format (PREFIX+LENGTH+CHARSET) and carries the
 * plaintext token in the controlled-plaintext `RuntimeCredential` wrapper (`env`,
 * runtime-adapter.contract) — a裸 string by design (injection writes env/stdin), NOT a
 * `SecretMaterial`; it is `zeroize()`d after injection (05 §4 明文纪律).
 */
const TOKEN_PREFIX = 'sk-ant-oat01-';
const TOKEN_CHAR = /^[A-Za-z0-9_-]+$/;

/** The authorization URL from the OSC-8 hyperlink (first claude.ai/anthropic link). */
export function parseClaudeAuthUrl(raw: string): string | null {
  const urls = extractOsc8Urls(raw);
  const url = urls.find((u) => /^https:\/\//i.test(u));
  return url ?? null;
}

/**
 * Reconstruct the folded setup-token. The token is printed as a block: the prefix
 * line + zero or more charset-only continuation lines. We take the charset run from
 * the prefix on its line, then append every following line that is charset-only
 * (a pty fold), stopping at the first line that isn't — so trailing instructions
 * are never joined in. A misjoined/mangled result is caught downstream by the
 * PREFIX+LENGTH+CHARSET validator (05 §3 P1-4c), never silently stored.
 */
export function parseClaudeSetupToken(raw: string): string | null {
  const clean = stripAnsi(raw);
  const lines = clean.split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes(TOKEN_PREFIX));
  if (i < 0) return null;

  const first = lines[i];
  const start = first.indexOf(TOKEN_PREFIX);
  let head = '';
  for (const ch of first.slice(start)) {
    if (/[A-Za-z0-9_-]/.test(ch)) head += ch;
    else break;
  }
  let token = head;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j].trim();
    if (l.length > 0 && TOKEN_CHAR.test(l)) token += l;
    else break;
  }
  return token;
}

// ── headless task event stream (`claude -p --output-format stream-json`, 04 §3 ★4) ──

/**
 * Parse a chunk of claude's structured stdout into `RuntimeEvent`s.
 *
 * Same discipline as the codex parser and the same measured basis: with
 * `--output-format stream-json` claude's stdout is clean JSONL (3/3 lines parsed,
 * stderr empty), so this is `JSON.parse` per line plus a name table — no regex.
 *
 * ⚠️ IT IS DELIBERATELY NOT SHARED WITH CODEX. codex emits one item per tool call
 * carrying its own output; claude emits the CALL inside an `assistant` message and the
 * RESULT inside a LATER `user` message, correlated by `tool_use_id`. A common parser
 * over those two shapes cannot be written honestly (04 §3 ★4), so each adapter maps
 * its own and the correlation is left to the consumer, which is the only place that
 * knows how long to hold a call open.
 *
 * ⚠️ SUCCESS IS `is_error`, NEVER `subtype`. Measured: a `result` line can carry
 * `subtype:"success"` and `is_error:true` at the same time, so keying off `subtype`
 * would report a failed task as succeeded.
 *
 * `timestamp` is empty for the same reason as codex: no `Clock` in infrastructure
 * (01 §3), and the CLI events carry none. The application layer stamps them.
 */
export function parseClaudeTaskEvents(chunk: string): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const parsed = safeJsonObject(trimmed);
    if (!parsed) continue;
    out.push(...mapClaudeEvent(parsed));
  }
  return out;
}

function mapClaudeEvent(e: Record<string, unknown>): RuntimeEvent[] {
  switch (e.type) {
    case 'system': {
      if (e.subtype !== 'init') return []; // `thinking_tokens` etc. carry no platform fact
      const ref = str(e.session_id);
      // Echoed back verbatim on a successful `--resume`, so the platform can confirm
      // the resume attached rather than assume it (04 §3 ★4).
      return ref === '' ? [] : [{ type: 'session-started', timestamp: '', data: { ref } }];
    }
    case 'assistant':
      return contentBlocks(e).flatMap((b) => mapAssistantBlock(b));
    case 'user':
      return contentBlocks(e).flatMap((b) => mapUserBlock(b));
    case 'result':
      // ⚠️ SUCCESS IS `is_error`, NEVER `subtype` — measured: a `result` line can carry
      // `subtype:"success"` and `is_error:true` at once. The completion payload is EMPTY
      // on purpose: the exit code is the JOB's fact, on the `/tasks` `exit` frame.
      return e.is_error === true
        ? [{ type: 'error', timestamp: '', data: { message: resultMessage(e) } }]
        : [{ type: 'task-complete', timestamp: '', data: {} }];
    default:
      return [];
  }
}

function mapAssistantBlock(block: Record<string, unknown>): RuntimeEvent[] {
  switch (block.type) {
    case 'text':
      return [{ type: 'agent-message', timestamp: '', data: { text: str(block.text) } }];
    case 'tool_use':
      return [
        {
          type: 'tool-call',
          timestamp: '',
          data: { status: 'started', id: str(block.id), name: str(block.name), input: block.input },
        },
      ];
    // `thinking` blocks are dropped: they are neither the prose the user asked for nor
    // a tool call, and inventing a member for them before a consumer exists is exactly
    // what 04 §3 ★4 says not to do.
    default:
      return [];
  }
}

/**
 * The COMPLETED half of a tool call, which claude puts in a LATER `user` message.
 *
 * The half carries no `name`, and that is exactly why the union splits on `status`:
 * `tool_result` only ever carries `tool_use_id`, and this parser is stateless per line
 * ON PURPOSE — an id→name table would make a live parse and a replayed parse produce
 * different payloads for the same bytes, which is the one thing the platform's `seq`
 * replay must never do. Consumers pair by `id`, where the name already arrived.
 *
 * ⚠️ `is_error` TRAVELS AS `isError`, NOT AS `exitCode: 1`. claude gives a boolean and no
 * exit code at all; synthesising a 1 would put a manufactured value in the same field
 * codex fills with a MEASURED one, and no consumer could tell them apart. `exitCode`
 * therefore stays reserved for real process exit codes, and the boolean says what it
 * actually is. Absent means "no failure reported", not "succeeded".
 */
function mapUserBlock(block: Record<string, unknown>): RuntimeEvent[] {
  if (block.type !== 'tool_result') return [];
  return [
    {
      type: 'tool-call',
      timestamp: '',
      data: {
        status: 'completed',
        id: str(block.tool_use_id),
        ...(block.is_error === true ? { isError: true } : {}),
        output: flattenContent(block.content),
      },
    },
  ];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** `result` may be prose or absent; the union has exactly one message field. */
function resultMessage(e: Record<string, unknown>): string {
  const result = str(e.result);
  if (result !== '') return result;
  const subtype = str(e.subtype);
  return subtype === '' ? 'claude reported an error' : `claude error (${subtype})`;
}

/**
 * `tool_result.content` is a string in the simple case and a block array in the rich
 * one. Both flatten to text here rather than being handed on as `unknown`: the field
 * is typed `output?: string`, so a consumer must not have to re-implement this.
 */
function flattenContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return '';
  return raw
    .map((b) =>
      typeof b === 'object' && b !== null ? str((b as Record<string, unknown>).text) : '',
    )
    .filter((t) => t !== '')
    .join('');
}

function contentBlocks(e: Record<string, unknown>): Record<string, unknown>[] {
  const message = e.message;
  if (typeof message !== 'object' || message === null) return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is Record<string, unknown> => typeof b === 'object' && b !== null && !Array.isArray(b),
  );
}

function safeJsonObject(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
