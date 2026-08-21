import { describe, it, expect } from 'vitest';
import {
  CREDENTIAL_REDIRECT_ENV_NAMES,
  RUNTIME_CREDENTIAL_ENV_NAMES,
  isReservedEnvName,
} from '../../src/reserved-env';

/**
 * Env blacklist reconcile (docs/backend/05 §4.1). The blacklist must cover every
 * runtime credential env name AND every redirect-class var (P1-2). This is the CI
 * assertion the doc requires: "adding a runtime whose cred name isn't blacklisted →
 * fail".
 */
describe('reserved env blacklist (05 §4.1)', () => {
  it('blocks CLAUDE_CONFIG_DIR (P1-2 redirect-class)', () => {
    expect(isReservedEnvName('CLAUDE_CONFIG_DIR')).toBe(true);
  });

  it('every runtime credential env name is blacklisted', () => {
    for (const name of RUNTIME_CREDENTIAL_ENV_NAMES) {
      expect(isReservedEnvName(name), `${name} must be reserved`).toBe(true);
    }
  });

  it('every redirect-class name is blacklisted (CLAUDE_CONFIG_DIR / CODEX_HOME / HOME)', () => {
    for (const name of CREDENTIAL_REDIRECT_ENV_NAMES) {
      expect(isReservedEnvName(name), `${name} must be reserved`).toBe(true);
    }
  });

  it('blocks the CODEX_* / GIT_* prefixes (covers CODEX_HOME, GIT_SSH_COMMAND)', () => {
    expect(isReservedEnvName('CODEX_HOME')).toBe(true);
    expect(isReservedEnvName('CODEX_ANYTHING')).toBe(true);
    expect(isReservedEnvName('GIT_SSH_COMMAND')).toBe(true);
  });

  it('permits an ordinary user variable', () => {
    expect(isReservedEnvName('MY_APP_FLAG')).toBe(false);
    expect(isReservedEnvName('NODE_ENV')).toBe(false);
  });
});
