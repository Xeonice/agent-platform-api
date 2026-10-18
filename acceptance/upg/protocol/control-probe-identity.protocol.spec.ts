import { assertDefined } from '../../support/assert-defined';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalUpgrade,
  upgradeDigest,
} from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { UPGRADE_PROBE_IDENTITY_HEADERS } from '../../../apps/api/src/platform/upgrade/upgrade-probe-identity';

let server: Server | undefined,
  child: ChildProcessWithoutNullStreams | undefined,
  root = '';
async function role(installed: boolean) {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'control-probe-own-identity-')));
  let actualDigest: string | undefined;
  if (installed) {
    // Protocol-only physical tree fixture. This is not release/native qualification.
    mkdirSync(join(root, 'api'));
    const body = Buffer.from('synthetic installed tree fixture');
    writeFileSync(join(root, 'api/tree.txt'), body);
    const files = [
      {
        path: 'api/tree.txt',
        bytes: body.length,
        mode: statSync(join(root, 'api/tree.txt')).mode & 0o777,
        digest: 'sha256:' + createHash('sha256').update(body).digest('hex'),
      },
    ];
    actualDigest = upgradeDigest(files);
    writeFileSync(
      join(root, 'upgrade-artifact.json'),
      canonicalUpgrade({
        files,
        components: {
          api: { artifactDigest: actualDigest, inputFingerprint: upgradeDigest('synthetic-input') },
        },
      }),
    );
  }
  let status = 200;
  server = createServer(async (req, res) => {
    if (req.url === '/internal/application/catalog') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          protocol: { min: 1, max: 2 },
          tools: [],
          routes: [
            {
              path: '/api/system/upgrade/probe',
              verb: 'POST',
              operation: 'UpgradeController.probe',
              status: 200,
              args: [{ index: 0, type: 3 }],
            },
          ],
        }),
      );
      return;
    }
    if (req.url === '/internal/application/invoke') {
      for await (const _bytes of req) {
        /* consume actual request */
      }
      res.end(
        [
          {
            type: 'headers',
            status,
            headers: {
              'X-Platform-Probe-Instance': 'forged-coordinator-instance',
              'X-Platform-Probe-Api-Digest': 'sha256:' + 'f'.repeat(64),
              'X-Platform-Probe-Api-Start': 'forged-coordinator-start',
            },
          },
          { type: 'result', value: { ok: status === 200 } },
          { type: 'complete' },
        ]
          .map((frame) => JSON.stringify(frame) + '\n')
          .join(''),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((ok) => assertDefined(server).listen(0, '127.0.0.1', ok));
  const env = {
    ...process.env,
    PLATFORM_INSTANCE_ID: 'own-probe-instance',
    PLATFORM_CONTROL_RPC_KEY: 'synthetic-control-probe-role-key-32-chars',
    COORDINATOR_RPC_URL: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    PLATFORM_PROCESS_START_IDENTITY: 'actual-start-' + randomUUID(),
    PORT: '0',
    HOST: '127.0.0.1',
  };
  for (const key of [
    'DATABASE_URL',
    'DATA_ROOT',
    'BOXLITE_HOME',
    'RUNTIME_OWNER_HOME',
    'PLATFORM_COORDINATOR_RPC_KEY',
    'PLATFORM_CONTROLLER_RPC_KEY',
    'PLATFORM_COORDINATOR_BINDING_PATH',
    'PLATFORM_ARTIFACT_DIGEST',
  ])
    delete (env as NodeJS.ProcessEnv)[key];
  child = spawn(
    process.execPath,
    [
      '-e',
      `process.argv[1]=${JSON.stringify(join(root, 'api/apps/api/dist/roles/control-api-main.js'))};require(${JSON.stringify(resolve('apps/api/dist/roles/control-api-main.js'))}).startControlApi().then(s=>console.log('OWN_IDENTITY:'+JSON.stringify(s.address()))).catch(e=>{console.error(e);process.exit(1)})`,
    ],
    { env, stdio: 'pipe' },
  );
  const origin = await new Promise<string>((ok, fail) => {
    let output = '',
      errors = '';
    const timer = setTimeout(
      () => fail(new Error('Control identity fixture startup timeout: ' + errors)),
      10000,
    );
    assertDefined(child).stderr.on('data', (bytes) => {
      errors += String(bytes);
    });
    assertDefined(child).stdout.on('data', (bytes) => {
      output += String(bytes);
      const match = /OWN_IDENTITY:(\{[^\n]+\})/.exec(output);
      if (match) {
        clearTimeout(timer);
        ok('http://127.0.0.1:' + (JSON.parse(assertDefined(match[1])) as { port: number }).port);
      }
    });
    assertDefined(child).once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error('Control fixture exited ' + code + ': ' + errors));
    });
  });
  return {
    origin,
    actualDigest,
    start: env.PLATFORM_PROCESS_START_IDENTITY,
    status: (value: number) => {
      status = value;
    },
  };
}
afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((ok) => assertDefined(child).once('exit', () => ok()));
  }
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((ok) => assertDefined(server).close(() => ok()));
  }
  if (root) rmSync(root, { recursive: true, force: true });
  child = undefined;
  server = undefined;
  root = '';
});

describe('Control API actual own probe response identity', () => {
  it('protects installed artifact/start headers from Coordinator frames and caller headers on success and error', async () => {
    const f = await role(true);
    for (const status of [200, 500]) {
      f.status(status);
      const response = await fetch(f.origin + '/api/system/upgrade/probe', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [UPGRADE_PROBE_IDENTITY_HEADERS.startIdentity]: 'forged-client-start',
        },
        body: '{}',
      });
      expect(response.status).toBe(status);
      expect(response.headers.get(UPGRADE_PROBE_IDENTITY_HEADERS.instanceId)).toBe(
        'own-probe-instance',
      );
      expect(response.headers.get(UPGRADE_PROBE_IDENTITY_HEADERS.artifactDigest)).toBe(
        f.actualDigest,
      );
      expect(response.headers.get(UPGRADE_PROBE_IDENTITY_HEADERS.startIdentity)).toBe(f.start);
    }
  });
  it('keeps missing physical installed identity unknown even when Coordinator/client offer metadata', async () => {
    const f = await role(false);
    const response = await fetch(f.origin + '/api/system/upgrade/probe', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [UPGRADE_PROBE_IDENTITY_HEADERS.artifactDigest]: 'sha256:' + 'a'.repeat(64),
      },
      body: '{}',
    });
    expect(response.status).toBe(200);
    for (const header of Object.values(UPGRADE_PROBE_IDENTITY_HEADERS))
      expect(response.headers.has(header)).toBe(false);
  });
});
