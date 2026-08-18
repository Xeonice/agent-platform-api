import { describe, it, expect } from 'vitest';
import {
  GIT_PLATFORM_REGISTRY,
  GIT_PLATFORM_IDS,
  defaultHostFor,
} from '../../src/net/git-platform-registry';

describe('git-platform registry (single source of truth)', () => {
  it('exposes the three first-class SaaS ids in insertion order', () => {
    expect(GIT_PLATFORM_IDS).toEqual(['github', 'gitlab', 'gitee', 'gitea']);
  });

  it('defaultHostFor resolves each registry id to its defaultHost', () => {
    for (const id of GIT_PLATFORM_IDS) {
      expect(defaultHostFor(id)).toBe(GIT_PLATFORM_REGISTRY[id].defaultHost);
    }
    expect(defaultHostFor('github')).toBe('github.com');
    expect(defaultHostFor('gitlab')).toBe('gitlab.com');
    expect(defaultHostFor('gitee')).toBe('gitee.com');
  });

  it('defaultHostFor returns null for the escape hatch and the absent hint', () => {
    expect(defaultHostFor('other')).toBeNull();
    expect(defaultHostFor(undefined)).toBeNull();
  });

  it('every registry row carries a non-empty label and defaultHost', () => {
    for (const id of GIT_PLATFORM_IDS) {
      const row = GIT_PLATFORM_REGISTRY[id];
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.defaultHost.length).toBeGreaterThan(0);
    }
  });
});
