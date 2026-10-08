import { describe, expect, it } from 'vitest';
import { shimLiveness } from '../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-shim-liveness';
import type { ShimProbeIo } from '../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-shim-liveness';

// BoxLite 0.9.7 writes `<pid>\n<starttime>\n` into boxes/<id>/shim.pid; the pid is the outer
// bwrap and the start time is field 22 of its /proc/<pid>/stat. Served from memory here.
const HOME = '/data/boxlite';
const BOX = 'd1RUbRaaWEB0';
const PID_FILE = `${HOME}/boxes/${BOX}/shim.pid`;

function stat(pid: number, state: string, startTime: number, comm = 'bwrap'): string {
  // 52 fields; only state (3) and starttime (22) matter. comm may hold spaces and parens.
  const tail = Array.from({ length: 49 }, (_, i) => (i === 19 ? String(startTime) : '0'));
  tail[0] = state;
  return `${String(pid)} (${comm}) ${tail.join(' ')}\n`;
}

function io(files: Record<string, string | Error>): ShimProbeIo & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    procRoot: '/proc',
    home: () => HOME,
    readFile: async (path) => {
      reads.push(path);
      const content = files[path];
      if (content instanceof Error) throw content;
      if (content === undefined)
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return content;
    },
  };
}

const PROCFS = { '/proc/self/stat': stat(1, 'R', 900, 'node') };

describe('a BoxLite box recorded as running is checked against its shim process', () => {
  it('a live root process whose start time matches the pid file is alive', async () => {
    expect(
      await shimLiveness(
        BOX,
        io({ ...PROCFS, [PID_FILE]: '29\n1098\n', '/proc/29/stat': stat(29, 'S', 1098) }),
      ),
    ).toBe('alive');
  });

  it('parses a process name with spaces and parentheses from the last closing paren', async () => {
    expect(
      await shimLiveness(
        BOX,
        io({
          ...PROCFS,
          [PID_FILE]: '29\n1098\n',
          '/proc/29/stat': stat(29, 'S', 1098, 'libkrun VM) (x'),
        }),
      ),
    ).toBe('alive');
  });

  it('a legacy single-line pid file can only prove that the process exists', async () => {
    expect(
      await shimLiveness(
        BOX,
        io({ ...PROCFS, [PID_FILE]: '29\n', '/proc/29/stat': stat(29, 'S', 1) }),
      ),
    ).toBe('alive');
  });

  it.each([
    ['the pid file is gone', { [PID_FILE]: undefined }],
    ['the process is gone', { '/proc/29/stat': undefined }],
    ['the process exited and was never reaped', { '/proc/29/stat': stat(29, 'Z', 1098) }],
    ['the process is being reaped', { '/proc/29/stat': stat(29, 'X', 1098) }],
    ['the pid now belongs to another process', { '/proc/29/stat': stat(29, 'S', 4242) }],
  ])('%s: the shim is gone', async (_label, change) => {
    const files: Record<string, string | Error> = {
      ...PROCFS,
      [PID_FILE]: '29\n1098\n',
      '/proc/29/stat': stat(29, 'S', 1098),
    };
    for (const [path, content] of Object.entries(change)) {
      if (content === undefined) delete files[path];
      else files[path] = content;
    }
    expect(await shimLiveness(BOX, io(files))).toBe('gone');
  });

  it('without procfs (macOS) nothing can be concluded, and the pid file is not even read', async () => {
    const probe = io({ [PID_FILE]: '29\n1098\n' });
    expect(await shimLiveness(BOX, probe)).toBe('unknown');
    expect(probe.reads).toEqual(['/proc/self/stat']);
  });

  it.each([
    [
      'an unreadable pid file',
      { [PID_FILE]: Object.assign(new Error('EACCES'), { code: 'EACCES' }) },
    ],
    ['a garbled pid file', { [PID_FILE]: 'not-a-pid\n' }],
    ['a zero pid', { [PID_FILE]: '0\n1098\n' }],
    ['an unreadable stat', { '/proc/29/stat': Object.assign(new Error('EIO'), { code: 'EIO' }) }],
    ['a truncated stat', { '/proc/29/stat': '29 (bwrap) S 1' }],
  ])('%s reads as unknown, never as gone', async (_label, change) => {
    expect(
      await shimLiveness(
        BOX,
        io({
          ...PROCFS,
          [PID_FILE]: '29\n1098\n',
          '/proc/29/stat': stat(29, 'S', 1098),
          ...change,
        }),
      ),
    ).toBe('unknown');
  });

  it('refuses to build a path from a box id that is not a BoxLite id', async () => {
    const probe = io({ ...PROCFS });
    expect(await shimLiveness('../../etc', probe)).toBe('unknown');
    expect(probe.reads).toEqual([]);
  });

  it('a home that cannot be resolved reads as unknown', async () => {
    const probe = io({ ...PROCFS });
    probe.home = () => {
      throw new Error('[vitest] No "boxliteHome" export is defined on the mock');
    };
    expect(await shimLiveness(BOX, probe)).toBe('unknown');
  });
});
