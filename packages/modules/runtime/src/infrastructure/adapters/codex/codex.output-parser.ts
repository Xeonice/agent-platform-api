import type { RuntimeEvent } from '@platform/contracts';
import { RUNTIME_REFRESH_TOKEN_PLACEHOLDER } from '@platform/shared-kernel';
import { stripAnsi } from '../ansi.util';

/**
 * Codex `login --device-auth` output parser (docs/backend/05 §1 ★2, §3). The output
 * is PLAIN TEXT — a verification URL (`https://auth.openai.com/codex/device`) + a
 * device code `XXXX-XXXXX` (15-min expiry). Plain-text regex is robust here (unlike
 * claude's OSC-8). Pure — golden-fixture tested (25 §2.3 CLI-AUTH-PARSE).
 */
const DEVICE_CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{5})\b/;
const VERIFICATION_URL_RE = /(https:\/\/auth\.openai\.com\/[^\s"']+)/i;

export interface CodexDeviceChallenge {
  verificationUrl: string;
  userCode: string;
}

export function parseCodexDeviceChallenge(raw: string): CodexDeviceChallenge | null {
  const text = stripAnsi(raw);
  const code = DEVICE_CODE_RE.exec(text);
  const url = VERIFICATION_URL_RE.exec(text);
  if (!code || !url) return null;
  return { verificationUrl: url[1], userCode: code[1] };
}

/**
 * True once the CLI has confirmed the device login succeeded (poll/complete). Matches
 * PRECISE success phrases only — a bare `includes('logged in')` also fires on the
 * FAILURE line "not logged in" (P2), so it is never used.
 */
export function codexLoginSucceeded(raw: string): boolean {
  const text = stripAnsi(raw).toLowerCase();
  return text.includes('successfully logged in') || text.includes('authentication complete');
}

export interface CodexAuthJson {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

/**
 * Parse `~/.codex/auth.json` (05 §1 ★2 実測 top-level keys). The `refresh_token` it
 * contains NEVER leaves the platform (P0-3) — see `sanitizeCodexAuthJson`.
 */
export function parseCodexAuthJson(jsonText: string): CodexAuthJson {
  return JSON.parse(jsonText) as CodexAuthJson;
}

/**
 * Produce the SANITIZED `auth.json` that is the ONLY form ever injected into a sandbox
 * (05 §1★★ / §4.3 裁决 D-18 ②): every field preserved verbatim, except
 * `tokens.refresh_token`, whose VALUE becomes the shared-kernel placeholder.
 *
 * Two details are load-bearing and must not be "simplified":
 *  - The FIELD IS KEPT. Deleting it makes codex fail with `missing field
 *    'refresh_token'` (05 §1★★ 実測); only the VALUE is replaced.
 *  - Unknown keys survive. The file's shape is OpenAI's, not ours; rebuilding it from
 *    a known-key allowlist would silently drop whatever the CLI adds next.
 *
 * This runs at credential BIRTH (`completeAuth` / `parseRefreshedAuth`), NOT on the
 * injection path — by the time `injectCredential` runs, the real refresh token is not
 * reachable at all (`InjectableRuntimeCredential` has no `authFile`).
 */
export function sanitizeCodexAuthJson(rawAuthJson: string): string {
  const parsed: unknown = JSON.parse(rawAuthJson);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('codex auth.json is not a JSON object');
  }
  const root = parsed as Record<string, unknown>;
  const tokens = root.tokens;
  const sanitizedTokens: Record<string, unknown> =
    typeof tokens === 'object' && tokens !== null && !Array.isArray(tokens)
      ? { ...(tokens as Record<string, unknown>) }
      : {};
  sanitizedTokens.refresh_token = RUNTIME_REFRESH_TOKEN_PLACEHOLDER;
  return JSON.stringify({ ...root, tokens: sanitizedTokens });
}

// ── headless task event stream (`codex exec --json`, 04 §3 ★4) ────────────────

/**
 * Parse a chunk of codex's structured stdout into `RuntimeEvent`s.
 *
 * ⚠️ NO REGEX, ON PURPOSE. §10 RA-04 listed "the CLI changes its output format" as
 * the parser's fragility, on the assumption that facts had to be scraped out of prose.
 * Measured (2026-08, real credentials): `codex exec --json` writes 100% clean JSONL to
 * stdout — 14/14 lines parsed, every tracing line on stderr — so this is
 * `JSON.parse` per line plus one name table, and the job plane keeping the two
 * streams apart (04 §2.6 裁决 3) is what preserves that.
 *
 * ⚠️ THIS IS NOT SHARED WITH CLAUDE AND CANNOT BE. codex reports one `item` per tool
 * call CARRYING ITS OWN OUTPUT; claude splits the call and its result across two
 * messages correlated by `tool_use_id`. The shapes are not isomorphic, so each
 * adapter maps its own (04 §3 ★4).
 *
 * `timestamp` is left EMPTY here and stamped by the application layer: `parseOutput`
 * is a pure infrastructure function with no `Clock`, and the repo bans reading the
 * wall clock outside that port (01 §3). None of the CLI events carries a timestamp
 * of its own to use instead.
 *
 * A line that is not valid JSON is DROPPED rather than guessed at. The job plane only
 * ever hands over whole lines (it holds a half line behind the cursor), so a
 * fragment here means the CLI wrote something non-JSONL — which is a fact about the
 * CLI, not something a parser should paper over.
 */
export function parseCodexTaskEvents(chunk: string): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const parsed = safeJson(trimmed);
    if (!parsed) continue;
    const event = mapCodexEvent(parsed);
    if (event) out.push(...event);
  }
  return out;
}

function mapCodexEvent(e: Record<string, unknown>): RuntimeEvent[] | null {
  switch (e.type) {
    case 'thread.started': {
      const ref = str(e.thread_id);
      // The id is echoed back on a successful `resume` too, which is what lets the
      // platform CONFIRM a resume really attached instead of assuming it (04 §3 ★4).
      return ref === '' ? null : [{ type: 'session-started', timestamp: '', data: { ref } }];
    }
    case 'item.started':
      return mapCodexItem(e.item, 'started');
    case 'item.completed':
      return mapCodexItem(e.item, 'completed');
    case 'turn.completed':
      // EMPTY payload on purpose: codex reports no exit code of its own, and the
      // process's exit status is the JOB's fact — it rides the `/tasks` `exit` frame.
      return [{ type: 'task-complete', timestamp: '', data: {} }];
    case 'turn.failed':
      return [{ type: 'error', timestamp: '', data: { message: errorMessage(e.error) } }];
    case 'error':
      return [{ type: 'error', timestamp: '', data: { message: str(e.message) || 'codex error' } }];
    // `turn.started` carries nothing the platform can act on.
    default:
      return null;
  }
}

/**
 * One codex `item` → at most one HALF of a tool call.
 *
 * `item.started` becomes the `started` half, `item.completed` the `completed` half.
 *
 * ⚠️ THAT PAIRING IS LOAD-BEARING under the union shape: `name` and `input` live ONLY on
 * the `started` half, so an item arriving as `completed` WITHOUT a preceding `started`
 * would lose both. It is backed by the per-type counts from the measured success-path
 * run (read a file → write a file → run `wc`; 04 §3 ★4):
 *
 *     item.started:   3                    item.completed: 5
 *       command_execution: 2                 command_execution: 2
 *       file_change:       1                 file_change:       1
 *                                            agent_message:     2
 *
 * The top-line 3-vs-5 gap is ENTIRELY `agent_message`, which is not a tool item at all
 * (it maps to `agent-message`). Both TOOL item types are strictly paired — 2:2 and 1:1.
 *
 * An item type nobody has measured is still a risk. If one turns out not to be paired,
 * the fix is one line HERE — emit both halves from its `completed` — and NOT a stateful
 * id→name lookup, which would make a live parse and a replayed parse produce different
 * payloads for the same bytes.
 *
 * `name` is the ITEM TYPE, not the command text: it is the "which kind of tool" axis,
 * matching claude's `tool_use.name`, while the specifics ride `input`. Putting the
 * command line in `name` would make the two runtimes disagree about what the field means.
 */
function mapCodexItem(raw: unknown, status: 'started' | 'completed'): RuntimeEvent[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const id = str(item.id);
  switch (item.type) {
    case 'agent_message':
      // only the completed half carries the text; a started half would render as an
      // empty bubble.
      return status === 'completed'
        ? [{ type: 'agent-message', timestamp: '', data: { text: str(item.text) } }]
        : null;
    case 'command_execution':
      return [
        status === 'started'
          ? {
              type: 'tool-call',
              timestamp: '',
              data: {
                status: 'started',
                id,
                name: 'command_execution',
                input: { command: item.command },
              },
            }
          : {
              type: 'tool-call',
              timestamp: '',
              data: {
                status: 'completed',
                id,
                ...(typeof item.exit_code === 'number' ? { exitCode: item.exit_code } : {}),
                ...(typeof item.aggregated_output === 'string'
                  ? { output: item.aggregated_output }
                  : {}),
              },
            },
      ];
    case 'file_change':
      return [
        status === 'started'
          ? {
              type: 'tool-call',
              timestamp: '',
              data: {
                status: 'started',
                id,
                name: 'file_change',
                input: { changes: item.changes },
              },
            }
          : { type: 'tool-call', timestamp: '', data: { status: 'completed', id } },
      ];
    // An item type we have never measured is DROPPED rather than force-fitted: calling
    // an unknown item a 'tool-call' would put a wrong label on it forever.
    default:
      return null;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** codex reports a failure as an object; flatten it to the one field the union has. */
function errorMessage(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw !== null) {
    const o = raw as Record<string, unknown>;
    const message = str(o.message);
    const type = str(o.type);
    if (message !== '') return type === '' ? message : `${type}: ${message}`;
    if (type !== '') return type;
  }
  return 'codex turn failed';
}

function safeJson(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
