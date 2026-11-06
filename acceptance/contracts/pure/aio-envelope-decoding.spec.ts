import { afterEach, describe, expect, it, vi } from 'vitest';
import { AioAgentHttp } from '../../../packages/modules/sandbox/src/infrastructure/providers/aio/aio-http';
import { listFiles } from '../../../packages/modules/sandbox/src/infrastructure/providers/aio/aio-files';

afterEach(() => vi.restoreAllMocks());
function response(payload: unknown): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('AIO actual envelope consumers validate external JSON', () => {
  it('rejects a truthy non-boolean success without treating it as an executed command', async () => {
    response({ success: 'false', data: { status: 'completed', stdout: 'invented', exit_code: 0 } });
    const http = new AioAgentHttp('http://127.0.0.1:1');
    await expect(http.postBashExec({ session_id: 'fixture', command: 'unused' })).rejects.toThrow(
      'exec failed',
    );
  });

  it('preserves absent verdicts and accepts a successful empty file-write payload', async () => {
    const http = new AioAgentHttp('http://127.0.0.1:1');
    response({
      success: true,
      data: { status: 'running', stdout: null, stderr: null, exit_code: null },
    });
    expect(await http.postBashExec({ session_id: 'fixture', command: 'unused' })).toEqual({
      status: 'running',
      stdout: null,
      stderr: null,
      exit_code: null,
    });
    vi.restoreAllMocks();
    response({ success: true, data: null });
    await expect(http.writeTextFile('/fixture.txt', 'owned fixture')).resolves.toBeUndefined();
  });

  it('keeps the agent direct-array listing encoding and absent directory facts', async () => {
    response({
      success: true,
      data: [
        { path: '/dir', is_directory: true, size: null, modified_time: 'unreadable' },
        { path: '/dir/file', is_directory: false, size: 4 },
      ],
    });
    expect(await listFiles(new AioAgentHttp('http://127.0.0.1:1'), '/dir')).toEqual([
      { path: '/dir', kind: 'dir' },
      { path: '/dir/file', kind: 'file', size: 4 },
    ]);
  });
});
