import { describe, expect, it } from 'vitest';
import { normalizeImageAlias } from '@platform/shared-kernel';
import { PatchImageSchema, RegisterImageSchema } from '@platform/contracts';
import { Image } from '../../../packages/modules/image/src/domain/entities/image.entity';
import { ImageAliasUpdated } from '../../../packages/modules/image/src/domain/events/image-events';

describe('AC-IMG-060.3/060.4/060.6 · one Unicode alias policy', () => {
  it('trims spaces, counts emoji as code points, clears blanks and preserves omission', () => {
    expect(normalizeImageAlias('  构建 Agent  ')).toBe('构建 Agent');
    expect(normalizeImageAlias('😀'.repeat(64))).toBe('😀'.repeat(64));
    expect(normalizeImageAlias('   ')).toBeNull();
    expect(normalizeImageAlias(null)).toBeNull();
    expect(RegisterImageSchema.parse({ ref: 'registry.test/agent:v1' })).not.toHaveProperty(
      'alias',
    );
    expect(PatchImageSchema.parse({})).not.toHaveProperty('alias');
    expect(PatchImageSchema.parse({ alias: null })).toEqual({ alias: null });
  });

  it.each([
    '😀'.repeat(65),
    '\tAgent',
    'Agent\n',
    '\rAgent',
    '\u0000Agent',
    'Agent\u007f',
    '\u0085Agent',
    '\u2028Agent',
    'Agent\u2029',
  ])('rejects raw illegal alias without hiding characters with trim', (alias) => {
    expect(() => normalizeImageAlias(alias)).toThrow();
    expect(PatchImageSchema.safeParse({ alias }).success).toBe(false);
    expect(RegisterImageSchema.safeParse({ ref: 'registry.test/agent:v1', alias }).success).toBe(
      false,
    );
  });

  it('allows the same alias on distinct Images and raises an event only on actual change', () => {
    const image = (id: string) =>
      Image.create({
        id,
        name: `registry.test/${id}`,
        ownerRef: null,
        isBuiltin: false,
        createdAt: new Date(0),
      });
    const first = image('one');
    const second = image('two');
    expect(first.updateAlias(' 构建 Agent ', new Date(1))).toBe(true);
    expect(second.updateAlias('构建 Agent', new Date(1))).toBe(true);
    expect(first.updateAlias('构建 Agent', new Date(2))).toBe(false);
    const events = first.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(ImageAliasUpdated);
    expect(events[0]).toMatchObject({ imageId: 'one', previousAlias: null, alias: '构建 Agent' });
  });
});
