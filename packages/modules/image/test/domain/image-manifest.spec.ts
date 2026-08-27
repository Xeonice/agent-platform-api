import { describe, it, expect } from 'vitest';
import { ImageManifest } from '../../src/domain/entities/image-manifest.entity';
import type { ImageManifestProps } from '../../src/domain/entities/image-manifest.entity';
import { ValidationOutcome } from '../../src/domain/value-objects/validation-outcome.vo';
import { Image } from '../../src/domain/entities/image.entity';
import { ImageNotDeletableError, ImageStateError } from '../../src/domain/errors/image-errors';

const REAL_DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = new Date('2026-08-25T00:00:00.000Z');

function props(over: Partial<ImageManifestProps> = {}): ImageManifestProps {
  return {
    id: 'imf-1',
    imageId: 'img-1',
    version: 'latest',
    baseImage: 'debian:bookworm',
    digest: REAL_DIGEST,
    entrypointContract: { workdir: '/', entrypoint: ['/bin/sh'] },
    supportedRuntimes: ['codex'],
    resourceDefaults: { cores: 1, ramMb: 512, diskMb: 1024 },
    labelsRequired: ['platform.tmux'],
    diffIds: ['sha256:layer-1', 'sha256:layer-2'],
    derivedFromDigest: null,
    validation: ValidationOutcome.from([], []),
    config: null,
    isActive: true,
    registeredAt: NOW,
    ...over,
  };
}

describe('ImageManifest.create guards the coordinate (I-IMG-6)', () => {
  it('refuses the exact placeholder the slice exists to delete', () => {
    // ⚠️ `'sha256:unresolved'` is NON-EMPTY, so the DB CHECK (`length(digest) > 0`)
    // accepts it happily — this is the one place that does not. Deleting the shape
    // check leaves the invariant enforced by a constraint that cannot see the problem
    // (04 §7 ★).
    expect(() => ImageManifest.create(props({ digest: 'sha256:unresolved' }))).toThrow(
      ImageStateError,
    );
    expect(() => ImageManifest.create(props({ digest: '' }))).toThrow(ImageStateError);
    expect(() => ImageManifest.create(props({ digest: 'sha256:abc' }))).toThrow(ImageStateError);
    expect(() => ImageManifest.create(props())).not.toThrow();
  });

  it('raises image.registered carrying the digest that was frozen', () => {
    const events = ImageManifest.create(props()).pullEvents();
    expect(events.map((e) => e.type)).toEqual(['image.registered']);
    expect(events[0]).toMatchObject({ manifestId: 'imf-1', digest: REAL_DIGEST });
  });
});

describe('activate refuses an invalid version (I-IMG-9)', () => {
  it('throws instead of making an unselectable version the current one', () => {
    const invalid = ImageManifest.rehydrate(
      props({
        isActive: false,
        validation: ValidationOutcome.from(
          [{ code: 'IMAGE_TMUX_MISSING', path: 'labels.platform.tmux', message: 'no tmux' }],
          [],
        ),
      }),
    );
    expect(() => invalid.activate(NOW)).toThrow(ImageStateError);
    // …and the row is NOT half-activated on the way out.
    expect(invalid.isActive).toBe(false);
    expect(invalid.pullEvents()).toEqual([]);
  });

  it('allows a `warning` version — 三级 is three levels, not two', () => {
    // ⚠️ THE MUTATION THIS CATCHES is 「refuse anything that is not `valid`」, which
    // reads as more careful and silently deletes the only state that means
    // 「能用，但你该知道这件事」 (P21-4 §9).
    const warned = ImageManifest.rehydrate(
      props({
        isActive: false,
        validation: ValidationOutcome.from(
          [],
          [{ code: 'RUNTIME_NOT_PREINSTALLED', message: 'claude-code not preinstalled' }],
        ),
      }),
    );
    expect(warned.validation.status).toBe('warning');
    expect(() => warned.activate(NOW)).not.toThrow();
    expect(warned.isActive).toBe(true);
  });
});

describe('the findings column carries whatever the current status is about', () => {
  it('stores errors when invalid, warnings when warning, nothing when clean', () => {
    const err = { code: 'IMAGE_TMUX_MISSING', path: 'labels.platform.tmux', message: 'x' };
    const warn = { code: 'RUNTIME_NOT_PREINSTALLED', message: 'y' };
    expect(
      ImageManifest.rehydrate(
        props({ validation: ValidationOutcome.from([err], [warn]) }),
      ).storedFindings(),
    ).toEqual([err]);
    expect(
      ImageManifest.rehydrate(
        props({ validation: ValidationOutcome.from([], [warn]) }),
      ).storedFindings(),
    ).toEqual([warn]);
    expect(ImageManifest.rehydrate(props()).storedFindings()).toBeNull();
  });
});

describe('a built-in image may be disabled, never deleted (I-IMG-4)', () => {
  it('refuses the delete of a built-in even when no sandbox references it', () => {
    // The FK only stops the delete of an image someone USED; this stops the delete of
    // a built-in nobody has touched yet, which the FK cannot see.
    const builtin = Image.rehydrate({
      id: 'img-1',
      name: 'ghcr.io/agent-infra/sandbox',
      ownerRef: null,
      isBuiltin: true,
      createdAt: NOW,
    });
    expect(() => builtin.assertDeletable()).toThrow(ImageNotDeletableError);
    expect(() =>
      Image.rehydrate({
        id: 'img-2',
        name: 'example.invalid/mine',
        ownerRef: null,
        isBuiltin: false,
        createdAt: NOW,
      }).assertDeletable(),
    ).not.toThrow();
  });
});
