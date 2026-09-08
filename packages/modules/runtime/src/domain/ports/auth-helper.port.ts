/**
 * AuthHelper PORT (docs/backend/11 §1.1, 05 §2 decision A). Lives in `domain` (like
 * git's materializer port) so infrastructure can IMPLEMENT it and application can
 * DRIVE it. The account-login CLI runs in the platform-managed auth helper — decoupled
 * from any task sandbox. Two forms hide behind this port (container via
 * `SandboxProvider.spawn({tty:true})`; host via `child_process`), transparent to
 * upper layers.
 *
 * Each `openSession` mints a FRESH isolated HOME (`mkdtemp`, P1-3) so concurrent
 * logins/refreshes never cross cred dirs; the caller `finally`-calls `dispose()` (kill
 * the process + `rm -rf` the temp HOME).
 *
 * ⚠️ WHICH ENV VARS POINT AT THAT HOME IS THE RUNTIME'S FACT, NOT THE HELPER'S. It
 * used to be a fixed `{ HOME, CLAUDE_CONFIG_DIR, CODEX_HOME }` — the two built-in CLIs'
 * variable names, written into platform code. A CLI that finds its credentials through
 * some other variable therefore wrote the freshly-minted login into the BACKEND
 * PROCESS's real home: outside the temp dir `dispose()` deletes, so it outlived the
 * session, and two concurrent logins shared one directory (04 §3 ★3z). The caller now
 * passes `RuntimeAdapter.configDirEnvNames` down; `HOME` itself is always set.
 */

/**
 * Structural twin of contracts' `ProcessStream` (domain must not import contracts —
 * boundaries §2.2). Identical shape ⇒ assignable when the app layer builds the
 * contracts `AuthSessionContext`.
 */
export interface HelperProcessStream {
  readonly ref: string;
  onData(cb: (chunk: Buffer) => void): void;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  onExit(cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): Promise<void>;
  /** 与 contracts 侧同义:松手但不触碰对面进程(结构孪生必须同步,否则赋值处当场编译红)。 */
  detach(): void;
}

export interface AuthHelperSession {
  pty: HelperProcessStream;
  /** The per-op isolated HOME — also the value of every `configDirEnvNames` entry. */
  homeDir: string;
  dispose(): Promise<void>;
}

/** A file to seed into the fresh HOME before the command runs (refresh scanner). */
export interface HelperSeedFile {
  /** Path RELATIVE to the isolated HOME (e.g. `auth.json`). */
  relPath: string;
  content: string;
  mode?: number;
}

export interface AuthHelper {
  /**
   * Mint a fresh isolated HOME, optionally seed files into it (05 §5.1: the refresh
   * scanner writes the current provider auth file so the CLI can refresh it), then
   * spawn `cmd` in a pty with `HOME` — plus every name in `configDirEnvNames` — set to
   * that directory.
   *
   * ⚠️ `configDirEnvNames` is a plain `string[]`, not a `RuntimeAdapter`: this port
   * lives in `domain`, which may not import contracts (boundaries §2.2). The caller
   * (application / infrastructure, both of which may) reads it off the adapter and
   * passes the names down — the same technique `HelperProcessStream` already uses to be
   * a structural twin of the contracts `ProcessStream`.
   */
  openSession(
    cmd: string[],
    seed?: HelperSeedFile[],
    configDirEnvNames?: readonly string[],
  ): Promise<AuthHelperSession>;
}

export const AUTH_HELPER = Symbol('AuthHelper');
