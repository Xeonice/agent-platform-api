import { SESSION_REF_RE } from '@platform/contracts';

/**
 * Refuse a `resumeFrom` that is not a CLI session id — the adapter-side half of the
 * check `RunAgentTaskSchema.resumeFrom` already applies at the API door.
 *
 * ⚠️ IT IS DELIBERATELY DUPLICATED. The value lands in argv as a POSITIONAL, and a
 * token starting with `-` is read by clap as an OPTION: `-cmodel_provider.base_url=…`
 * is a codex config override, and codex's credentials sit in `~/.codex/auth.json` —
 * so a bad value here is "send the injected key to an attacker's endpoint", not a
 * cosmetic parse error. `--` closes the option list as well; this check makes the
 * value itself harmless even if a future caller reaches `buildStartCommand` without
 * passing through the schema (the MCP tool, an internal retry, a test).
 */
export function assertSessionRef(ref: string): string {
  if (!SESSION_REF_RE.test(ref)) {
    throw new Error(
      `resumeFrom '${ref}' is not a CLI session id (UUID or ULID); refusing to put it in argv`,
    );
  }
  return ref;
}
