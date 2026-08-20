import { Injectable } from '@nestjs/common';
import type { RuntimeAdapter, RuntimeAdapterRegistry } from '@platform/contracts';
import { CodexAdapter } from '../adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../adapters/claude-code/claude-code.adapter';

/**
 * Open RuntimeAdapter registry (04 §8, RUNTIME_ADAPTER_REGISTRY token). Registers the
 * two built-ins; third-party adapters register against the same token — application
 * code depends on the registry, never the concrete adapters.
 */
@Injectable()
export class DefaultRuntimeAdapterRegistry implements RuntimeAdapterRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();

  constructor(codex: CodexAdapter, claude: ClaudeCodeAdapter) {
    this.adapters.set(codex.id, codex);
    this.adapters.set(claude.id, claude);
  }

  get(id: string): RuntimeAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`unknown runtime '${id}'`);
    return a;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  list(): RuntimeAdapter[] {
    return [...this.adapters.values()];
  }
}
