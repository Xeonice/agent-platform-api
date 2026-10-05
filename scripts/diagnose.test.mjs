import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { diagnose } from './diagnose.mjs';

test('后端没有启动：真实 Node/native/数据目录与端口独立自检，临时文件被清理', async () => {
  const folder = await mkdtemp(resolve(tmpdir(), 'standalone-diagnose-'));
  const held = createServer();
  await new Promise((done) => held.listen(0, '127.0.0.1', done));
  const port = held.address().port;
  await new Promise((done) => held.close(done));
  try {
    const report = await diagnose({ dataRoot: folder, host: '127.0.0.1', port });
    assert.equal(report.backendRequired, false);
    assert.equal(report.ok, true);
    assert.deepEqual(
      report.results.map((result) => result.id),
      ['node', 'native-modules', 'data-root', 'port'],
    );
    assert.deepEqual(await readdir(folder), []);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
test('真实端口冲突与非目录路径分别失败，不能伪装正常', async () => {
  const folder = await mkdtemp(resolve(tmpdir(), 'standalone-diagnose-'));
  await writeFile(resolve(folder, 'file'), 'x');
  const held = createServer();
  await new Promise((done) => held.listen(0, '127.0.0.1', done));
  try {
    const report = await diagnose({
      dataRoot: resolve(folder, 'file'),
      host: '127.0.0.1',
      port: held.address().port,
    });
    assert.equal(report.ok, false);
    assert.equal(report.results.find((result) => result.id === 'data-root').status, 'fail');
    assert.match(report.results.find((result) => result.id === 'port').detail, /EADDRINUSE/);
  } finally {
    await new Promise((done) => held.close(done));
    await rm(folder, { recursive: true, force: true });
  }
});
