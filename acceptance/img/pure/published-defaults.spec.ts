import { afterEach, describe, expect, it } from 'vitest';
import {
  builtinImageRefFor,
  builtinImageRefs,
  publishedImageFor,
  isManagedBuiltinImageDefault,
} from '@platform/shared-kernel';
import { useEnv } from '../../support/strict-ports';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function defaults(common?: string, boxlite?: string) {
  cleanup.push(
    useEnv({
      SANDBOX_DEFAULT_IMAGE: common,
      SANDBOX_BOXLITE_IMAGE: boxlite,
      SANDBOX_AIO_IMAGE: undefined,
    }),
  );
}
describe('package-bound official sandbox defaults', () => {
  it('binds unconfigured and both historical official latest aliases to this package version', () => {
    for (const common of [
      undefined,
      '',
      'ghcr.io/xeonice/agent-platform-boxlite:latest',
      'ghcr.io/xeonice/agent-platform-sandbox:latest',
    ]) {
      defaults(common);
      for (const provider of ['aio', 'boxlite']) {
        expect(builtinImageRefFor(provider)).toBe(publishedImageFor(provider));
        expect(isManagedBuiltinImageDefault(provider)).toBe(true);
        expect(builtinImageRefFor(provider)).toContain(':v0.3.12-cli.20261017.1');
      }
      expect(builtinImageRefs(['aio', 'boxlite', 'boxlite'])).toHaveLength(2);
    }
  });
  it('preserves exact user tags, digests, nonofficial repositories and provider overrides', () => {
    for (const ref of [
      'ghcr.io/xeonice/agent-platform-boxlite:older',
      `ghcr.io/xeonice/agent-platform-boxlite@sha256:${'a'.repeat(64)}`,
      'mirror.test/agent-platform-boxlite:latest',
    ]) {
      defaults(ref);
      expect(builtinImageRefFor('boxlite')).toBe(ref);
      expect(isManagedBuiltinImageDefault('boxlite')).toBe(false);
    }
    defaults(
      'ghcr.io/xeonice/agent-platform-boxlite:latest',
      'ghcr.io/xeonice/agent-platform-boxlite:latest',
    );
    expect(builtinImageRefFor('boxlite')).toBe('ghcr.io/xeonice/agent-platform-boxlite:latest');
    expect(isManagedBuiltinImageDefault('boxlite')).toBe(false);
    defaults('third-party.test/custom:latest');
    expect(builtinImageRefFor('external')).toBe('third-party.test/custom:latest');
    expect(isManagedBuiltinImageDefault('external')).toBe(false);
  });
});
