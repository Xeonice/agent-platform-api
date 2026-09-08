import type { RuntimeCredentialFile, SandboxExecFn } from '@platform/contracts';
import { SEED_WRITE_TIMEOUT_MS } from './home-probe.util';

/**
 * Writing a credential file into a sandbox, done safely — extracted so every adapter
 * (built-in AND out-of-tree) shares ONE implementation.
 *
 * ⛔ WHY THIS IS THE MOST IMPORTANT THING IN THIS FOLDER TO SHARE. Three separate
 * hazards are encoded in five words of shell below, and a re-implementation that misses
 * ANY of them still passes RA-14/15/16 — those clauses check what the adapter SENDS, not
 * how the file behaves on disk:
 *
 *   · `umask 077` — without it, `cat > "$1"` creates the file at 0644 (or whatever the
 *     sandbox's umask says) and only the LATER `chmod` tightens it. In that window the
 *     credential is world-readable to every process in the sandbox, which is exactly the
 *     population it is being hidden from. The window is short; the agent runs unattended
 *     for hours. ⚠️ **RA-14/15/16 cannot see this**: the bytes sent are identical either
 *     way, so a copy that drops `umask 077` is green.
 *   · CONTENT ON STDIN, NEVER IN ARGV — `/proc/<pid>/cmdline` is world-readable inside
 *     the sandbox, so a secret in argv is readable by `ps` (05 §4/§7 #3, RA-14).
 *   · THE PATH IS A POSITIONAL, NOT INTERPOLATED — so no path can be parsed as shell
 *     syntax. (`$0` is a label; `$1` is the path, `$2` the mode.)
 */
export const WRITE_FILE_SCRIPT =
  'set -e; mkdir -p "$(dirname "$1")"; umask 077; cat > "$1"; chmod "$2" "$1"';

/** Credential material is always owner-only unless the file says otherwise. */
export const CREDENTIAL_FILE_MODE = '0600';

/** Octal mode literal; anything else falls back to `0600` rather than reaching `chmod`. */
const MODE_RE = /^[0-7]{3,4}$/;

/**
 * Materialize ONE `~/`-relative credential file at its expanded path, owner-only.
 *
 * `home` comes from `probeSandboxHome(exec, …)` — the LIVE sandbox's `$HOME`, probed and
 * never cached across sandboxes (05 §4.3 裁决 D-19). `fail` builds the adapter's own
 * error so this helper stays free of any one adapter's taxonomy; pass
 * `(m) => new AdapterAuthError('AUTH_REJECTED', m)` for the 04 §4 mapping.
 *
 * ⚠️ THE CONTENT IS WRITTEN VERBATIM. No JSON parsing, no field rewriting: the sanitized
 * form was produced at credential BIRTH (05 §4.3 裁决 D-18), and re-deriving it here
 * would put the real `refresh_token` back on the injection path.
 */
export async function writeCredentialFile(
  exec: SandboxExecFn,
  file: RuntimeCredentialFile,
  home: string,
  fail: (message: string) => Error,
  label = 'inject',
): Promise<void> {
  if (!file.containerPath.startsWith('~/')) {
    // 裁决 D-19: an absolute path here would mean the path was resolved before a
    // sandbox existed — i.e. against the wrong HOME, or pinning this credential to
    // one sandbox. Refuse rather than write to a guessed location.
    throw fail(`credential file path must be ~/-relative, got '${file.containerPath}'`);
  }
  const mode = file.mode && MODE_RE.test(file.mode) ? file.mode : CREDENTIAL_FILE_MODE;
  const absolutePath = `${home}/${file.containerPath.slice(2)}`;
  const r = await exec(['sh', '-c', WRITE_FILE_SCRIPT, label, absolutePath, mode], {
    stdin: file.content,
    timeoutMs: SEED_WRITE_TIMEOUT_MS,
  });
  if (r.exitCode !== 0) {
    throw fail(`writing ${file.containerPath} failed (exit ${r.exitCode})`);
  }
}
