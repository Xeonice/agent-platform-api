import { Injectable } from '@nestjs/common';
import { UnknownRuntimeError } from '@platform/contracts';
import type { RuntimeAdapter, RuntimeAdapterRegistry } from '@platform/contracts';
import { CodexAdapter } from '../adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../adapters/claude-code/claude-code.adapter';

/**
 * Open RuntimeAdapter registry (04 §8, RUNTIME_ADAPTER_REGISTRY token). Registers the
 * two built-ins; third-party adapters register against the same token — application
 * code depends on the registry, never the concrete adapters.
 *
 * The built-ins arrive via the constructor but go through the SAME public `register()`
 * an out-of-tree module calls from its `onModuleInit`, so there is one registration
 * path and one uniqueness check.
 */
@Injectable()
export class DefaultRuntimeAdapterRegistry implements RuntimeAdapterRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();

  constructor(codex: CodexAdapter, claude: ClaudeCodeAdapter) {
    this.register(codex);
    this.register(claude);
  }

  /**
   * Register an adapter (04 §8). A duplicate `id` FAILS FAST — a third-party package
   * shadowing `codex` must break at boot rather than silently take over its logins.
   */
  register(a: RuntimeAdapter): void {
    if (this.adapters.has(a.id)) {
      throw new Error(`duplicate runtime adapter id '${a.id}' — ids must be unique (04 §8)`);
    }
    this.adapters.set(a.id, a);
  }

  /**
   * ⚠️ A TYPED error, not a bare `Error`. Every caller that skips the `has()` guard —
   * the task pump re-attaching after a restart, the terminal building an attach command
   * — funnels its throw into a `code`-reading failure path, and a bare `Error` has no
   * `code`, so it landed as `INTERNAL`: "内部错误" for a fact the platform knows
   * exactly ("no adapter is registered under this id", 04 §8 / 14 §10).
   */
  get(id: string): RuntimeAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new UnknownRuntimeError(id);
    return a;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  list(): RuntimeAdapter[] {
    return [...this.adapters.values()];
  }
}
