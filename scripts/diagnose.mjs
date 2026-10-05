#!/usr/bin/env node
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 独立自检：只测当前进程、原生绑定、目录写入和端口绑定；不要求 API 或数据库已启动。 */
export async function diagnose(options = {}) {
  const dataRoot = resolve(options.dataRoot ?? process.env.DATA_ROOT ?? resolve(apiRoot, 'data'));
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const results = [];
  const major = Number(process.versions.node.split('.')[0]);
  results.push({
    id: 'node',
    status: major >= 22 ? 'ok' : 'fail',
    label: 'Node 版本',
    detail: `${process.version}（需要 Node 22 或以上）`,
  });
  try {
    const require = createRequire(resolve(apiRoot, 'apps/api/package.json'));
    const Database = require('better-sqlite3');
    const database = new Database(':memory:');
    try {
      database.prepare('SELECT 1').get();
    } finally {
      database.close();
    }
    results.push({
      id: 'native-modules',
      status: 'ok',
      label: '原生模块',
      detail: 'better-sqlite3 绑定已加载且 SQLite 可执行',
    });
  } catch (error) {
    results.push({
      id: 'native-modules',
      status: 'fail',
      label: '原生模块',
      detail: `better-sqlite3 无法加载：${error instanceof Error ? error.message : String(error)}；用当前 Node 版本重新安装依赖。`,
    });
  }
  let probe;
  try {
    const info = await stat(dataRoot);
    if (!info.isDirectory()) throw new Error('路径不是目录');
    await access(dataRoot, constants.R_OK | constants.W_OK | constants.X_OK);
    probe = await mkdtemp(resolve(dataRoot, '.diagnose-'));
    await writeFile(resolve(probe, 'probe'), 'diagnose', { flag: 'wx' });
    if ((await readFile(resolve(probe, 'probe'), 'utf8')) !== 'diagnose')
      throw new Error('写入后读取不一致');
    results.push({
      id: 'data-root',
      status: 'ok',
      label: '数据目录',
      detail: `${dataRoot} 可读写`,
    });
  } catch (error) {
    results.push({
      id: 'data-root',
      status: 'fail',
      label: '数据目录',
      detail: `${dataRoot}：${error instanceof Error ? error.message : String(error)}；检查 DATA_ROOT、目录是否存在与当前用户权限。`,
    });
  } finally {
    if (probe !== undefined) await rm(probe, { recursive: true, force: true });
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    results.push({
      id: 'port',
      status: 'fail',
      label: '平台端口',
      detail: `PORT 必须是 1–65535 的整数（当前 ${String(port)}）`,
    });
  } else {
    const result = await new Promise((done) => {
      const server = createServer();
      server.once('error', (error) =>
        done({
          id: 'port',
          status: 'fail',
          label: '平台端口',
          detail: `${host}:${String(port)} 无法绑定（${error.code ?? error.message}）；确认端口占用与 HOST 配置。`,
        }),
      );
      server.listen({ host, port, exclusive: true }, () =>
        server.close(() =>
          done({
            id: 'port',
            status: 'ok',
            label: '平台端口',
            detail: `${host}:${String(port)} 可绑定`,
          }),
        ),
      );
    });
    results.push(result);
  }
  return { backendRequired: false, results, ok: results.every((result) => result.status === 'ok') };
}

async function main() {
  // Node 版本不支持 .env 加载时仍能跑版本检查，不在 shell 入口就失败。
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(resolve(apiRoot, '.env'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const args = process.argv.slice(2);
  const options = {};
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') json = true;
    else if (arg === '--data-root' || arg === '--port' || arg === '--host') {
      const value = args[++index];
      if (value === undefined) throw new Error(`${arg} 缺少值`);
      options[arg === '--data-root' ? 'dataRoot' : arg.slice(2)] = value;
    } else throw new Error(`未知参数 ${arg}；可用 --json、--data-root、--port、--host`);
  }
  const report = await diagnose(options);
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write('平台独立自检（不依赖后端）\n');
    for (const result of report.results)
      process.stdout.write(
        `[${result.status === 'ok' ? '正常' : '失败'}] ${result.label}：${result.detail}\n`,
      );
  }
  process.exitCode = report.ok ? 0 : 1;
}
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
