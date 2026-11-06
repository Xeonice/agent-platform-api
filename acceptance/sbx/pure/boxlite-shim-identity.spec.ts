import { describe, expect, it, vi } from 'vitest';
import {
  boxliteShimIdentity,
  type ShimIdentityIo,
} from '../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-shim-identity';

const box = 'physical-box';
const birth = '1791950000123456';
const pidPath = `/data/boxlite/boxes/${box}/shim.pid`;
function fixture(platform: NodeJS.Platform = 'darwin'): ShimIdentityIo {
  const statFields = Array.from({ length: 49 }, () => '0');
  statFields[0] = 'S';
  statFields[19] = birth;
  return {
    platform,
    home: () => '/data/boxlite',
    readFile: vi.fn(async (path) => {
      if (path === pidPath) return `29\n${birth}\n`;
      if (path === '/proc/29/stat') return `29 (shim with ) parentheses) ${statFields.join(' ')}`;
      throw new Error('Unexpected read');
    }),
    darwinProcessStart: vi.fn(async () => ({ pid: 29, startTime: birth })),
  };
}

describe('verified BoxLite shim physical identity', () => {
  it('compares Darwin epoch microseconds exactly and never reads procfs', async () => {
    const io = fixture();
    expect(await boxliteShimIdentity(box, io)).toBe(`boxlite:${box}:shim:29:${birth}`);
    expect(io.darwinProcessStart).toHaveBeenCalledWith(29);
    expect(io.readFile).toHaveBeenCalledTimes(2);
    expect(vi.mocked(io.readFile).mock.calls.every(([path]) => path === pidPath)).toBe(true);
  });

  it.each(['1791950000123457', '1791950000000000'])(
    'rejects a reused PID or rounded second-level timestamp %s',
    async (actual) => {
      const io = fixture();
      io.darwinProcessStart = async () => ({ pid: 29, startTime: actual });
      expect(await boxliteShimIdentity(box, io)).toBeNull();
    },
  );

  it('rejects a missing/dead process, denied kernel read and wrong PID', async () => {
    const io = fixture();
    io.darwinProcessStart = async () => null;
    expect(await boxliteShimIdentity(box, io)).toBeNull();
    io.darwinProcessStart = async () => {
      throw new Error('EACCES');
    };
    expect(await boxliteShimIdentity(box, io)).toBeNull();
    io.darwinProcessStart = async () => ({ pid: 30, startTime: birth });
    expect(await boxliteShimIdentity(box, io)).toBeNull();
  });

  it.each(['29\n', '29\ngarbled\n', '0\n123\n', '2147483648\n123\n'])(
    'does not confirm incomplete or invalid record %j',
    async (record) => {
      const io = fixture();
      io.readFile = async () => record;
      expect(await boxliteShimIdentity(box, io)).toBeNull();
      expect(io.darwinProcessStart).not.toHaveBeenCalled();
    },
  );

  it('rejects a concurrent restart that replaces the recorded incarnation', async () => {
    const io = fixture();
    let reads = 0;
    io.readFile = async () => (++reads === 1 ? `29\n${birth}\n` : `30\n${birth}\n`);
    expect(await boxliteShimIdentity(box, io)).toBeNull();
  });

  it('preserves Linux field-22 identity semantics and ignores command-name parentheses', async () => {
    const io = fixture('linux');
    expect(await boxliteShimIdentity(box, io)).toBe(`boxlite:${box}:shim:29:${birth}`);
    expect(io.darwinProcessStart).not.toHaveBeenCalled();
  });

  it.each(['Z', 'X'])('rejects exited Linux state %s', async (state) => {
    const io = fixture('linux');
    const read = io.readFile;
    io.readFile = async (path) => (await read(path)).replace(') S ', `) ${state} `);
    expect(await boxliteShimIdentity(box, io)).toBeNull();
  });

  it('rejects traversal, relative homes and unsupported hosts without invented evidence', async () => {
    const io = fixture();
    expect(await boxliteShimIdentity('../other', io)).toBeNull();
    expect(io.readFile).not.toHaveBeenCalled();
    io.home = () => 'relative';
    expect(await boxliteShimIdentity(box, io)).toBeNull();
    io.home = () => '/data/boxlite';
    io.platform = 'win32';
    expect(await boxliteShimIdentity(box, io)).toBeNull();
  });
});
