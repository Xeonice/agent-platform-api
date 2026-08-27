import { isReservedEnvName } from '@platform/shared-kernel';
import {
  ENV_DUPLICATE_KEY,
  ENV_LIMIT_EXCEEDED,
  ENV_NAME_INVALID,
  ENV_NAME_RESERVED,
  EnvValidationError,
} from '../errors/image-errors';
import type { EnvValidationIssue } from '../errors/image-errors';

/**
 * `EnvVarSet` — 构造即校验 (docs/backend/23 §9.3, I-IMG-1).
 *
 * ⚠️ WHY A VALUE OBJECT AND NOT 「a validate() call in the service」. The SAME six
 * rules apply in THREE places (image config, project-level override v1.1, task-level
 * override). As a value object, 「存在即合法」: there is no way to hold an
 * `EnvVarSet` that broke a rule, so none of the three can forget to check. As a
 * service method it is three call sites, i.e. three chances to miss one — and the one
 * that misses `CODEX_HOME` lets a user redirect a CLI at a credential directory of
 * their choosing.
 *
 * The set is IMMUTABLE; every 「modification」 returns a new instance.
 */

export const ENV_MAX_ENTRIES = 50;
export const ENV_MAX_NAME_LENGTH = 64;
/** ⚠️ BYTES, not characters — a 4096-char CJK value is ~12KB (13 §2.4.3). */
export const ENV_MAX_VALUE_BYTES = 4096;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface EnvVarInput {
  key: string;
  value: string;
  secret?: boolean;
}

export interface EnvVarEntry {
  readonly key: string;
  readonly value: string;
  readonly secret: boolean;
}

export class EnvVarSet {
  private constructor(readonly entries: readonly EnvVarEntry[]) {}

  static empty(): EnvVarSet {
    return new EnvVarSet([]);
  }

  /**
   * Validate and build. Throws `EnvValidationError` carrying EVERY violation.
   *
   * ⚠️ THE LIMIT CHECKS RUN EVEN ON ENTRIES THAT ALREADY FAILED THE NAME CHECK. A
   * per-entry `continue` after the first issue is the natural way to write this and it
   * is wrong for the same reason 「first error only」 is: the user fixes the name, and
   * the value length they never heard about fails the next round-trip.
   */
  static create(inputs: readonly EnvVarInput[]): EnvVarSet {
    const issues: EnvValidationIssue[] = [];

    if (inputs.length > ENV_MAX_ENTRIES) {
      issues.push({
        path: 'env',
        code: ENV_LIMIT_EXCEEDED,
        message: `环境变量最多 ${String(ENV_MAX_ENTRIES)} 条，当前 ${String(inputs.length)} 条`,
      });
    }

    const seen = new Set<string>();
    inputs.forEach((entry, i) => {
      const at = `env[${String(i)}]`;
      if (!ENV_NAME_RE.test(entry.key)) {
        issues.push({
          path: `${at}.key`,
          code: ENV_NAME_INVALID,
          message: '变量名不合法：只允许字母、数字与下划线，且不能以数字开头',
        });
      } else if (isReservedEnvName(entry.key)) {
        // `else if`: a name that is not even well-formed cannot meaningfully be
        // 「reserved」, and reporting both codes for one field gives the UI two
        // contradictory things to render under one input.
        issues.push({
          path: `${at}.key`,
          code: ENV_NAME_RESERVED,
          message: '该变量名为系统保留，请使用凭证管理配置',
        });
      }
      if (entry.key.length > ENV_MAX_NAME_LENGTH) {
        issues.push({
          path: `${at}.key`,
          code: ENV_LIMIT_EXCEEDED,
          message: `变量名超出上限 ${String(ENV_MAX_NAME_LENGTH)} 字符`,
        });
      }
      if (Buffer.byteLength(entry.value, 'utf8') > ENV_MAX_VALUE_BYTES) {
        issues.push({
          path: `${at}.value`,
          code: ENV_LIMIT_EXCEEDED,
          message: `变量值超出上限 ${String(ENV_MAX_VALUE_BYTES)} 字节`,
        });
      }
      // 大小写敏感 (13 §2.4.3): `Path` and `PATH` are two different variables to a
      // POSIX process, so folding them here would reject a legal pair.
      if (seen.has(entry.key)) {
        issues.push({
          path: `${at}.key`,
          code: ENV_DUPLICATE_KEY,
          message: '同一镜像内变量名不能重复',
        });
      }
      seen.add(entry.key);
    });

    if (issues.length > 0) throw new EnvValidationError(issues);
    return new EnvVarSet(
      inputs.map((e) => ({ key: e.key, value: e.value, secret: e.secret ?? false })),
    );
  }

  get size(): number {
    return this.entries.length;
  }

  find(key: string): EnvVarEntry | undefined {
    return this.entries.find((e) => e.key === key);
  }

  /** Plain `KEY=value` map, last writer wins. Used by `EnvMergeService`. */
  toRecord(): Record<string, string> {
    return Object.fromEntries(this.entries.map((e) => [e.key, e.value]));
  }
}
