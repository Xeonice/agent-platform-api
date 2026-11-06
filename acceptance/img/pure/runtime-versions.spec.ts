import { describe, expect, it } from 'vitest';
import {
  normalizeRuntimeVersions,
  parseRuntimeVersionsLabel,
} from '../../../packages/modules/image/src/domain/value-objects/runtime-versions.vo';

describe('AC-IMG-062.2 · image runtime version declarations · untrusted optional metadata', () => {
  it('keeps exact versions, including prerelease/build identifiers, for known runtime ids', () => {
    expect(
      parseRuntimeVersionsLabel(
        JSON.stringify({
          codex: '0.163.0',
          'claude-code': '2.1.302-rc.1+build.23',
          other: '1.0.0',
        }),
      ),
    ).toEqual({ codex: '0.163.0', 'claude-code': '2.1.302-rc.1+build.23' });
    expect(normalizeRuntimeVersions(Object.create({ codex: '1.2.3' }))).toEqual({});
  });

  it.each([
    undefined,
    '',
    'not JSON',
    'null',
    '[]',
    '"1.2.3"',
    JSON.stringify({ codex: null, 'claude-code': 123 }),
    JSON.stringify({ codex: '1.2.3\n', 'claude-code': '1.2.3\u0000' }),
    JSON.stringify({ codex: 'v1.2.3', 'claude-code': 'claude 2.1.302' }),
    JSON.stringify({ codex: '01.2.3', 'claude-code': '1.2.3-01' }),
    JSON.stringify({ codex: '<script>alert(1)</script>', 'claude-code': '1.2' }),
    JSON.stringify({ codex: `1.2.3+${'a'.repeat(128)}` }),
    ' '.repeat(4097),
  ])('treats missing or invalid declarations as unknown (%j)', (label) => {
    expect(parseRuntimeVersionsLabel(label)).toEqual({});
  });

  it('does not let one invalid CLI value discard a valid independent declaration', () => {
    expect(parseRuntimeVersionsLabel('{"codex":"0.163.0","claude-code":"2.1.302\\r\\n"}')).toEqual({
      codex: '0.163.0',
    });
    expect(parseRuntimeVersionsLabel('{"__proto__":{"codex":"9.9.9"}}')).toEqual({});
  });
});
