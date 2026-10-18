import { describe, expect, it } from 'vitest';
import { assertDefined } from '../../support/assert-defined';
import { stub, unused } from '../../support/strict-ports';

describe('fixture evidence guards', () => {
  it.each([null, undefined])('rejects absent evidence: %s', (value) => {
    expect(() => assertDefined(value, 'missing expected receipt')).toThrow(
      'missing expected receipt',
    );
  });
  it.each([false, 0, '', NaN])('preserves a defined falsy value: %s', (value) => {
    expect(assertDefined(value)).toBe(value);
  });
  it('preserves the original object identity', () => {
    const value = { receipt: 'original' };
    expect(assertDefined(value)).toBe(value);
  });
  it('partial ports execute supplied members and reject every unprovided dependency', () => {
    const port = stub<{ read(): number; write(): void }>({ read: () => 7 }, 'test port');
    expect(port.read()).toBe(7);
    expect(() => port.write()).toThrow('test port.write is outside this scenario');
  });
  it('unused ports fail on the first dependency access', () => {
    const port = unused<{ read(): number }>('unused port');
    expect(() => port.read()).toThrow('unused port.read is outside this scenario');
  });
});
