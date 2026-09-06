import { describe, it, expect } from 'vitest';
import { eventField } from '../../../../../test-support/unused';
import { ImageManifest } from '../../src/domain/entities/image-manifest.entity';
import type { ImageManifestProps } from '../../src/domain/entities/image-manifest.entity';
import { ValidationOutcome } from '../../src/domain/value-objects/validation-outcome.vo';
import { Image } from '../../src/domain/entities/image.entity';
import { ImageNotDeletableError, ImageStateError } from '../../src/domain/errors/image-errors';

const REAL_DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = new Date('2026-08-25T00:00:00.000Z');
/** 完整坐标 —— 事件带的是它，不是 `version` 那一段（13 §2.8.2：summary 不许出现 UUID）。 */
const REF = 'registry.local/platform/sandbox:latest';

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
    expect(() => ImageManifest.create(props({ digest: 'sha256:unresolved' }), REF)).toThrow(
      ImageStateError,
    );
    expect(() => ImageManifest.create(props({ digest: '' }), REF)).toThrow(ImageStateError);
    expect(() => ImageManifest.create(props({ digest: 'sha256:abc' }), REF)).toThrow(
      ImageStateError,
    );
    expect(() => ImageManifest.create(props(), REF)).not.toThrow();
  });

  it('raises image.registered carrying the digest that was frozen', () => {
    const events = ImageManifest.create(props(), REF).pullEvents();
    expect(events.map((e) => e.type)).toEqual(['image.registered']);
    expect(events[0]).toMatchObject({ manifestId: 'imf-1', digest: REAL_DIGEST, ref: REF });
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
    expect(() => invalid.activate(REF, NOW)).toThrow(ImageStateError);
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
    expect(() => warned.activate(REF, NOW)).not.toThrow();
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

/**
 * 每个改动型操作都发事件、且每条都带**完整坐标** —— 平台级 `AuditProjector` 靠它写出
 * 「停用镜像 registry.local/platform/sandbox:latest」而不是一串 UUID（13 §2.8.2）。
 */
describe('镜像事件带的是用户认得的 ref，不是 manifestId', () => {
  it('五个改动型操作 + 删除各发一条，全部带 ref', () => {
    const m = ImageManifest.create(props(), REF);
    m.pullEvents(); // 丢掉 image.registered

    m.recordValidation(ValidationOutcome.from([], []), REF, NOW);
    m.deactivate(REF, NOW);
    m.activate(REF, NOW);
    m.updateConfig({ env: [] }, REF, NOW);
    m.markDeleted(REF, NOW);

    const events = m.pullEvents();
    expect(events.map((e) => e.type)).toEqual([
      'image.validated',
      'image.deactivated',
      'image.activated',
      'image.config_updated',
      'image.deleted',
    ]);
    for (const e of events) {
      expect(eventField<string>(e, 'ref')).toBe(REF);
      // ⚠️ 否定断言是重点：光断言「有 ref 字段」的话，把 `manifestId` 也拼进去的
      // 写法照样绿，而那正是 summary 上重新长出 UUID 的路径。
      expect(eventField<string>(e, 'ref')).not.toContain('imf-1');
    }
  });

  it('事件是**类**，projector 的 instanceof 才有东西可判', () => {
    // 接口在运行期什么都不是，只能退回按 `e.type` 字符串比对 —— 而字符串比对在字段
    // 改名、事件拆分时一条编译错误都不会有，正是审计这一侧最不该有的沉默。
    const [registered] = ImageManifest.create(props(), REF).pullEvents();
    expect(registered.constructor.name).toBe('ImageRegistered');
  });
});
