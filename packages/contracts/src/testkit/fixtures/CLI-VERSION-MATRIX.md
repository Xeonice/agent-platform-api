# CLI Output Golden Fixtures — VERSION MATRIX (placeholder)

> Authority: docs/backend/04 §10.3 (RA-04) and 05 §6.
>
> RuntimeAdapter output parsers (`claude-code.output-parser`, `codex.output-parser`,
> and the auth device-code/URL scrapers) are the single most fragile point in the
> system: **a CLI upgrade that changes output format silently breaks them**. The
> golden fixtures under this directory are the one line of defense — testkit clause
> RA-04 replays recorded real CLI output against the parser and asserts the expected
> structured result.

## Rule

**Every newly supported CLI version MUST add a fixture here**, and this matrix MUST
be updated. A fixture is raw recorded stdout/stderr plus the expected parsed result.

## Matrix

| Runtime     | CLI version | fixture file                       | status      |
| ----------- | ----------- | ---------------------------------- | ----------- |
| claude-code | _tbd_       | `claude-code/<version>.golden.txt` | placeholder |
| codex       | _tbd_       | `codex/<version>.golden.txt`       | placeholder |

_No real fixtures are recorded yet — the RuntimeAdapter implementations land in a
later slice. This file reserves the convention and the CI obligation._
