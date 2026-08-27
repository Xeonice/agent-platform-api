import { describe, it, expect } from 'vitest';
import { EnvVarSet } from '../../src/domain/value-objects/env-var-set.vo';
import { EnvValidationError } from '../../src/domain/errors/image-errors';

/**
 * `EnvVarSet` — 构造即校验 (23 §9.3, I-IMG-1; 25 §3.5 T-IMG-1..10).
 *
 * The rules are exercised as a TABLE because that is the only way to keep 「三处复用
 * 同一套规则」 honest: a rule that quietly stops being enforced shows up as one dead
 * row rather than as a test nobody wrote.
 */
const VALID = { key: 'LOG_LEVEL', value: 'info' };

describe('EnvVarSet.create accepts a legal set', () => {
  it('keeps entries in order and defaults `secret` to false', () => {
    const set = EnvVarSet.create([VALID, { key: '_UNDERSCORE_START', value: 'ok', secret: true }]);
    expect(set.entries.map((e) => e.key)).toEqual(['LOG_LEVEL', '_UNDERSCORE_START']);
    expect(set.find('LOG_LEVEL')?.secret).toBe(false);
    expect(set.find('_UNDERSCORE_START')?.secret).toBe(true);
  });

  it('treats `Path` and `PATH` as different variables (case SENSITIVE)', () => {
    // ⚠️ NOT A NIT. A POSIX process sees two distinct variables here, so folding case
    // would reject a legal pair — and, worse, would make `path` look reserved.
    expect(() => EnvVarSet.create([{ key: 'Path', value: 'a' }])).not.toThrow();
  });
});

describe.each([
  {
    what: 'a name that starts with a digit',
    entries: [{ key: '1BAD', value: 'x' }],
    code: 'ENV_NAME_INVALID',
    path: 'env[0].key',
  },
  {
    what: 'a name with a dash',
    entries: [{ key: 'NOT-OK', value: 'x' }],
    code: 'ENV_NAME_INVALID',
    path: 'env[0].key',
  },
  {
    what: 'an exact reserved name',
    entries: [{ key: 'OPENAI_API_KEY', value: 'x' }],
    code: 'ENV_NAME_RESERVED',
    path: 'env[0].key',
  },
  {
    what: 'a HOME override (redirect class)',
    entries: [{ key: 'HOME', value: '/tmp' }],
    code: 'ENV_NAME_RESERVED',
    path: 'env[0].key',
  },
  {
    what: 'a CODEX_* prefixed name',
    entries: [{ key: 'CODEX_HOME', value: '/tmp' }],
    code: 'ENV_NAME_RESERVED',
    path: 'env[0].key',
  },
  {
    what: 'a GIT_* prefixed name',
    entries: [{ key: 'GIT_SSH_COMMAND', value: 'ssh' }],
    code: 'ENV_NAME_RESERVED',
    path: 'env[0].key',
  },
  {
    what: 'a name longer than 64 characters',
    entries: [{ key: `A${'B'.repeat(64)}`, value: 'x' }],
    code: 'ENV_LIMIT_EXCEEDED',
    path: 'env[0].key',
  },
  {
    what: 'a duplicate key',
    entries: [VALID, { key: 'LOG_LEVEL', value: 'debug' }],
    code: 'ENV_DUPLICATE_KEY',
    path: 'env[1].key',
  },
])('EnvVarSet.create rejects $what', ({ entries, code, path }) => {
  it(`with ${code} at ${path}`, () => {
    try {
      EnvVarSet.create(entries);
      expect.unreachable('construction must have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const issues = (e as EnvValidationError).issues;
      expect(issues.map((i) => i.code)).toContain(code);
      expect(issues.find((i) => i.code === code)?.path).toBe(path);
    }
  });
});

describe('the limits that are about SIZE, not shape', () => {
  it('rejects a 51st entry with the specific ceiling in the message', () => {
    const entries = Array.from({ length: 51 }, (_, i) => ({ key: `K${String(i)}`, value: 'v' }));
    try {
      EnvVarSet.create(entries);
      expect.unreachable('51 entries must be refused');
    } catch (e) {
      const issue = (e as EnvValidationError).issues.find((i) => i.code === 'ENV_LIMIT_EXCEEDED');
      // The number has to be IN the sentence: 「超出上限」 without the limit is a
      // message that cannot be acted on (P21-4 §10.3).
      expect(issue?.message).toContain('50');
      expect(issue?.path).toBe('env');
    }
    expect(() => EnvVarSet.create(entries.slice(0, 50))).not.toThrow();
  });

  it('measures the value ceiling in BYTES, not characters', () => {
    // ⚠️ THE MUTATION THIS CATCHES IS `value.length > 4096`. 2048 CJK characters are
    // only 2048 `.length` — well under a character-based ceiling — but 6144 UTF-8
    // bytes, which is what actually lands in the database and in the container's
    // environment block. A character-based check passes this input and the byte-based
    // one rejects it, so the two implementations are distinguishable HERE and only
    // here.
    const cjk = '中'.repeat(2048); // 6144 bytes, 2048 chars
    expect(Buffer.byteLength(cjk, 'utf8')).toBe(6144);
    expect(cjk.length).toBe(2048);
    try {
      EnvVarSet.create([{ key: 'BIG', value: cjk }]);
      expect.unreachable('a 6144-byte value must be refused');
    } catch (e) {
      const issue = (e as EnvValidationError).issues.find((i) => i.code === 'ENV_LIMIT_EXCEEDED');
      expect(issue?.path).toBe('env[0].value');
    }
    // …and a value that is 4096 BYTES exactly is accepted.
    expect(() => EnvVarSet.create([{ key: 'BIG', value: 'a'.repeat(4096) }])).not.toThrow();
  });
});

describe('the error carries EVERY violation, not the first', () => {
  it('reports three bad entries in one throw, each with its own path', () => {
    // ⚠️ A `throw` inside the loop passes every single-violation test above and fails
    // only this one — and the user-visible cost is three round-trips to fix one form.
    try {
      EnvVarSet.create([
        { key: '1BAD', value: 'x' },
        { key: 'HOME', value: 'x' },
        { key: 'OK', value: '中'.repeat(2048) },
      ]);
      expect.unreachable('must have thrown');
    } catch (e) {
      const issues = (e as EnvValidationError).issues;
      expect(issues.map((i) => i.path)).toEqual(['env[0].key', 'env[1].key', 'env[2].value']);
    }
  });

  it('never echoes the submitted VALUE back in a message', () => {
    // The messages go into an envelope, a log line and a user's screenshot, and an
    // env value is the likeliest place for a plaintext token (10 §6.8).
    const secret = 'sk-live-DO-NOT-ECHO-0123456789';
    try {
      EnvVarSet.create([{ key: 'ANTHROPIC_API_KEY', value: secret }]);
      expect.unreachable('must have thrown');
    } catch (e) {
      const dump = JSON.stringify((e as EnvValidationError).issues);
      expect(dump).not.toContain(secret);
    }
  });
});
