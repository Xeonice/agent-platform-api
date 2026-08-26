import { describe, it, expect } from 'vitest';
import {
  formatImageRef,
  isDerivedFrom,
  isOciDigest,
  parseImageRef,
  pinnedImageRef,
} from '../../src/image-spec.contract';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('pinnedImageRef — 04 §7 时刻④', () => {
  it('appends the digest so the provider pulls BITS, not a tag', () => {
    // ⚠️ THE WHOLE POINT OF FREEZING A DIGEST LIVES HERE. Steps ①②③ pin a coordinate
    // into the database; if this returns the bare tag, all three were bookkeeping and
    // `:latest` still drifts under the platform's feet.
    expect(pinnedImageRef({ ref: 'ghcr.io/x/y:latest', digest: DIGEST })).toBe(
      `ghcr.io/x/y:latest@${DIGEST}`,
    );
  });

  it('degrades to the tag when there is no real digest to pin', () => {
    // A pre-slice sandbox row has no recoverable digest (13 §2.1 迁移). Emitting
    // `img:tag@sha256:unresolved` would be an unpullable reference — i.e. the
    // placeholder causing a failure instead of merely being useless.
    expect(pinnedImageRef({ ref: 'alpine:3.20', digest: '' })).toBe('alpine:3.20');
    expect(pinnedImageRef({ ref: 'alpine:3.20', digest: 'sha256:unresolved' })).toBe('alpine:3.20');
  });

  it('never double-pins an already digest-form reference', () => {
    expect(pinnedImageRef({ ref: `ghcr.io/x/y@${DIGEST}`, digest: DIGEST })).toBe(
      `ghcr.io/x/y@${DIGEST}`,
    );
  });
});

describe('isOciDigest is a SHAPE check, not a truthiness check', () => {
  it('rejects the placeholder that the old implementation shipped', () => {
    expect(isOciDigest('sha256:unresolved')).toBe(false);
    expect(isOciDigest(`sha256:${'A'.repeat(64)}`)).toBe(false); // uppercase is not canonical
    expect(isOciDigest(`sha256:${'a'.repeat(63)}`)).toBe(false);
    expect(isOciDigest(DIGEST)).toBe(true);
  });
});

describe('parseImageRef', () => {
  it.each([
    ['alpine', { name: 'alpine', tag: 'latest' }],
    ['alpine:3.20', { name: 'alpine', tag: '3.20' }],
    ['ghcr.io/a/b:v1', { name: 'ghcr.io/a/b', tag: 'v1' }],
    [`ghcr.io/a/b@${DIGEST}`, { name: 'ghcr.io/a/b', digest: DIGEST }],
  ])('%s', (ref, expected) => {
    expect(parseImageRef(ref)).toEqual(expected);
  });

  it('does NOT mistake a registry PORT for a tag', () => {
    // ⚠️ `ref.indexOf(':')` reads `localhost:5001/img` as name `localhost` + tag
    // `5001/img` — a name that resolves to a completely different image on Docker Hub.
    // The boxlite e2e stages through exactly this `:5001` mirror, so the bug would be
    // silent everywhere except where it matters most.
    expect(parseImageRef('localhost:5001/agent-infra/sandbox:latest')).toEqual({
      name: 'localhost:5001/agent-infra/sandbox',
      tag: 'latest',
    });
    expect(parseImageRef('localhost:5001/img')).toEqual({
      name: 'localhost:5001/img',
      tag: 'latest',
    });
  });
});

describe('formatImageRef', () => {
  it('joins with `@` for a digest and `:` for a tag', () => {
    expect(formatImageRef('ghcr.io/a/b', 'v1')).toBe('ghcr.io/a/b:v1');
    expect(formatImageRef('ghcr.io/a/b', DIGEST)).toBe(`ghcr.io/a/b@${DIGEST}`);
  });
});

/**
 * `isDerivedFrom` — 04 §7 ★血统, the注册期 fact that replaced the label declaration.
 *
 * ⚠️ WHY THIS FUNCTION IS TESTED DIRECTLY AND NOT ONLY THROUGH REGISTRATION. Deleting
 * the `base.length === 0` guard and running the application-layer suite leaves it GREEN
 * — because `lineageFinding` filters empty anchors out before ever calling here, so the
 * second guard silently covers for the first. That is the 「摘掉一道守卫但另一道接住了」
 * shape: the mutation is real, the tests do not notice, and the day the OTHER guard is
 * refactored the rule quietly stops rejecting anything. A shared exported helper needs
 * its own clause for each property its doc comment promises.
 */
describe('isDerivedFrom — 血统 = diff_ids 前缀（04 §7 ★）', () => {
  const L = (n: number): string => `sha256:${String(n).repeat(64).slice(0, 64)}`;
  const base = [L(1), L(2), L(3)];

  it('base + 新层 ⇒ 派生', () => {
    expect(isDerivedFrom([...base, L(9)], base)).toBe(true);
    expect(isDerivedFrom([...base, L(9), L(8)], base)).toBe(true);
  });

  it('完全相同 ⇒ 也算派生：LABEL / ENV / CMD 不产生新层（实测）', () => {
    expect(isDerivedFrom([...base], base)).toBe(true);
  });

  it('⭐ 空 base 永远不是锚点 —— 否则它是所有镜像的前缀，规则形同虚设', () => {
    // A manifest whose `rootfs.diff_ids` could not be read stores `[]` (pre-slice rows,
    // and any provider that omits it). If `[]` counted as an anchor, ONE such row would
    // silently admit every image on earth while the rule appeared to still be there.
    expect(isDerivedFrom([L(1)], [])).toBe(false);
    expect(isDerivedFrom([], [])).toBe(false);
  });

  it('方向不能反：祖先不是自己派生出来的东西', () => {
    expect(isDerivedFrom(base, [...base, L(9)])).toBe(false);
    expect(isDerivedFrom([L(1)], base)).toBe(false);
  });

  it('比的是前缀，不是集合：中间层不同就不算', () => {
    expect(isDerivedFrom([L(1), L(7), L(3), L(9)], base)).toBe(false);
    expect(isDerivedFrom([L(9), ...base], base)).toBe(false);
  });
});
