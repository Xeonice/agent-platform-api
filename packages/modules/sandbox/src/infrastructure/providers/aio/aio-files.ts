import { Readable } from 'node:stream';
import {
  SandboxProviderError,
  SandboxProviderErrorCode,
  type FileEntry,
} from '@platform/contracts';
import { epochSecondsToIso } from '@platform/shared-kernel';
import {
  isJsonResponse,
  isNotFoundEnvelope,
  isNotFoundMessage,
  readEnvelope,
  type AioAgentHttp,
} from './aio-http';

/**
 * 文件面（04 §2.6 `SandboxFiles`）—— 走 agent 自己的 `/v1/file/*`。
 *
 * ⚠️ 与 `boxlite-files.ts` **对称，但通道完全不同**，而这正是决策 A 修订的要点：
 * boxlite 那边被迫走 `exec + base64`（实测 SDK 的 `copyIn/copyOut` 看不见任何挂载点，
 * 而平台唯一真正会读的 `/workspace/.agent-artifacts` 恰恰是个卷）；aio 这边沙箱自己
 * 就有文件 API，8MB 往返 36ms。两边都是「问沙箱要」，不是「从外面撬」。
 *
 * ⚠️ **两条 not-found 约定必须都归一成 `null`**：`download` 回 404，而 `read` 回
 * HTTP 200 + `success:false` + `error_type:"not_found"`。任务失败时 codex 的
 * `-o/--output-last-message <FILE>` 根本不会被创建 —— 那是**正常路径**，不是错误。
 *
 * ⚠️ 本文件是**自由函数 + 显式传 `http`**，不是一个持有连接的类。理由与 boxlite 同源：
 * 数据面没有任何跨调用的状态值得藏（作业面那个 ws 才有，它住在 `aio-jobs.ts`）。
 */

// ── 文件面 / file plane (SandboxFiles, 04 §2.6) ──────────────────────────────

/**
 * Whole-file read, BINARY SAFE. It must go through `GET /v1/file/download`
 * (`application/octet-stream`): the agent's text-oriented `POST /v1/file/read`
 * raises `'utf-8' codec can't decode byte 0xa3` on binary content, so it cannot
 * back this method at all.
 *
 * A MISSING FILE IS `null`, NOT AN ERROR — that is a normal path: codex's
 * `-o/--output-last-message <FILE>` is simply not created when the task fails. The
 * two agent endpoints disagree on how they report it (download answers 404, read
 * answers HTTP 200 with `success:false` + `error_type:"not_found"`); both are
 * normalised here so no caller ever sees the difference.
 */
export async function readFileBytes(http: AioAgentHttp, path: string): Promise<Buffer | null> {
  const res = await http.get(`/v1/file/download?path=${encodeURIComponent(path)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.INTERNAL,
      `AIO agent file download failed: HTTP ${res.status} for ${path}`,
    );
  }
  const body = Buffer.from(await res.arrayBuffer());
  return isNotFoundEnvelope(res, body) ? null : body;
}

/** Streaming read for artifacts too large to hold in memory. `null` when absent. */
export async function openFileStream(
  http: AioAgentHttp,
  path: string,
): Promise<NodeJS.ReadableStream | null> {
  const res = await http.get(`/v1/file/download?path=${encodeURIComponent(path)}`);
  if (res.status === 404) return null;
  if (!res.ok || res.body === null) {
    if (res.ok) return null;
    throw new SandboxProviderError(
      SandboxProviderErrorCode.INTERNAL,
      `AIO agent file download failed: HTTP ${res.status} for ${path}`,
    );
  }
  // A JSON `not_found` envelope arrives with a 200, so it cannot be detected from
  // headers alone without consuming the body — only the JSON content type can
  // possibly be one, and an artifact served as octet-stream never is.
  if (isJsonResponse(res)) {
    const body = Buffer.from(await res.arrayBuffer());
    return isNotFoundEnvelope(res, body) ? null : Readable.from(body);
  }
  return Readable.fromWeb(res.body);
}

/**
 * Write through the agent's file API so the content travels in an HTTP BODY.
 * Measured: missing parent directories are created for us, and `encoding:"base64"`
 * round-trips binary intact — which is why `mkdir` is absent from the plane rather
 * than merely discouraged.
 */
export async function writeFileContent(
  http: AioAgentHttp,
  path: string,
  content: string | Buffer,
): Promise<void> {
  const body = Buffer.isBuffer(content)
    ? { file: path, content: content.toString('base64'), encoding: 'base64' }
    : { file: path, content };
  const res = await http.post('/v1/file/write', body);
  const parsed = await readEnvelope(res);
  if (!res.ok || parsed.success === false) {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.INTERNAL,
      `AIO agent file write failed: HTTP ${res.status} ${parsed.message ?? ''}`.trim(),
    );
  }
}

/**
 * Directory listing, normalised to `FileEntry`. Two agent encodings are converted
 * HERE so they never leak into the contract (04 §2.6): `size` is `null` for
 * directories (⇒ the field is ABSENT, not 0), and `modified_time` is epoch SECONDS
 * WRAPPED IN A STRING (⇒ ISO-8601). A missing directory lists as EMPTY rather than
 * throwing — "the task produced no artifacts" is a normal outcome, not a fault.
 */
export async function listFiles(
  http: AioAgentHttp,
  path: string,
  opts?: { recursive?: boolean; maxEntries?: number },
): Promise<FileEntry[]> {
  const res = await http.post('/v1/file/list', {
    path,
    recursive: opts?.recursive ?? false,
    include_size: true,
  });
  if (res.status === 404) return [];
  const parsed = await readEnvelope(res);
  if (!res.ok || parsed.success === false) {
    if (isNotFoundMessage(parsed.message)) return [];
    throw new SandboxProviderError(
      SandboxProviderErrorCode.INTERNAL,
      `AIO agent file list failed: HTTP ${res.status} ${parsed.message ?? ''}`.trim(),
    );
  }
  const rows = agentFileRows(parsed.data);
  const limit = opts?.maxEntries;
  const capped = limit !== undefined && limit >= 0 ? rows.slice(0, limit) : rows;
  return capped.map((row) => toFileEntry(row));
}

/**
 * ATTACH to an existing job session — never create one.
 *
 * The `?session_id=` is what makes the agent treat this socket as an attachment
 * (`created_by_ws = false`), so disconnecting leaves the session, its buffered
 * output and the running command untouched. Without it the socket owns the
 * session and closing it destroys the job. Verified end to end: 33-minute run,
 * 100 s of silence × 20 rounds, zero disconnects; three client SIGKILLs left the
 * session and the job alive.
 *
 * Failure to attach is NOT fatal — `readJob` falls back to the agent's own
 * long-poll — so this returns `null` instead of throwing.

/** Locate the row array whichever key this agent build puts it under. */
function agentFileRows(data: unknown): Record<string, unknown>[] {
  const candidates: unknown[] = [data];
  if (typeof data === 'object' && data !== null) {
    const o = data as Record<string, unknown>;
    candidates.push(o.files, o.entries, o.items);
  }
  for (const c of candidates) {
    if (Array.isArray(c)) {
      return c.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
    }
  }
  return [];
}

function toFileEntry(row: Record<string, unknown>): FileEntry {
  const isDir = row.is_directory === true;
  const size = typeof row.size === 'number' ? row.size : undefined;
  return {
    path: typeof row.path === 'string' ? row.path : String(row.name ?? ''),
    kind: isDir ? 'dir' : 'file',
    // measured: the agent reports `size: null` for a directory ⇒ ABSENT, not 0.
    ...(isDir || size === undefined ? {} : { size }),
    modifiedAt: epochSecondsToIso(row.modified_time) ?? '',
  };
}
