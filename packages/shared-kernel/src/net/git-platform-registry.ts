/**
 * Single source of truth for the public git SaaS "one-class-citizen" platforms
 * (docs/backend/13 §2.5.1, 03 §7.3 H). ONE table drives the whole stack:
 *   - the `GitPlatform` union type (below),
 *   - the wire `GitPlatformSchema` zod enum (contracts derives its values from
 *     `GIT_PLATFORM_IDS` + 'other' — so the OpenAPI enum follows this table),
 *   - the default probe host (`defaultHostFor`, replaces the old per-platform switch).
 *
 * WHY shared-kernel: this is a pure catalog of reachable public git hosts — the same
 * nature as `git-remote.ts` next to it. It carries no credential business concepts,
 * so BOTH bounded contexts (contracts + each module's domain) can depend on it, which
 * is exactly what lets `GitPlatform` have a single definition instead of a copy per
 * layer (the domain boundary forbids `domain → contracts`, but `domain → shared-kernel`
 * is allowed, and `contracts → shared-kernel` introduces no cycle).
 *
 * ADDING A PUBLIC SaaS AS A FIRST-CLASS CITIZEN = add ONE row here. That row
 * automatically drives: the `GitPlatform` type, the zod enum, the OpenAPI enum and
 * `defaultHostFor`. Optionally also pin its SSH host key in
 * `credential/.../infrastructure/git/known-hosts.ts` under its `defaultHost`; without a
 * pin the host simply falls back to `accept-new` TOFU. No switch/case anywhere changes.
 */
export const GIT_PLATFORM_REGISTRY = {
  github: { label: 'GitHub', defaultHost: 'github.com' },
  gitlab: { label: 'GitLab', defaultHost: 'gitlab.com' },
  gitee: { label: 'Gitee', defaultHost: 'gitee.com' },
  gitea: { label: 'Gitea', defaultHost: 'gitea.com' },
} as const;

/** The registry keys — the "first-class citizen" platform ids (excludes 'other'). */
export type GitPlatformId = keyof typeof GIT_PLATFORM_REGISTRY;

/**
 * The full non-sensitive platform hint (13 §2.5.1): a first-class id OR the escape
 * hatch `'other'` (any self-hosted / not-yet-catalogued host).
 */
export type GitPlatform = GitPlatformId | 'other';

/** Ordered registry ids (insertion order: github, gitlab, gitee) — drives the zod/OpenAPI enum. */
export const GIT_PLATFORM_IDS = Object.keys(GIT_PLATFORM_REGISTRY) as GitPlatformId[];

/**
 * Map a platform hint to its default probe host, or null when there is none to derive
 * ('other', an unknown value, or absent). Table lookup — replaces the old switch.
 */
export function defaultHostFor(platform: GitPlatform | undefined): string | null {
  if (platform === undefined || platform === 'other') return null;
  return Object.prototype.hasOwnProperty.call(GIT_PLATFORM_REGISTRY, platform)
    ? GIT_PLATFORM_REGISTRY[platform].defaultHost
    : null;
}
