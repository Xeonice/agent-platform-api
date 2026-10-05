import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { io } from 'socket.io-client';
import { sql } from 'drizzle-orm';
import { DATABASE } from '@platform/shared-kernel';
import { RuntimeApplicationService } from '@platform/runtime';
import type { Db } from '../../../apps/api/src/platform/persistence/drizzle.connection';
import { createPlatform } from '../../support/platform-app';
import { AuthSessionStore } from '../../../packages/modules/runtime/src/application/auth-session.store';
import { AuthChallenge } from '../../../packages/modules/runtime/src/domain/value-objects/auth-challenge.vo';
import { deferred } from '../../support/strict-ports';

const PASSCODE = 'synthetic-deployment-passcode';
async function deployment() {
  const directory = mkdtempSync(join(tmpdir(), 'deployment-barrier-'));
  const drainFile = join(directory, 'drain');
  const h = await createPlatform({
    DATA_ROOT: directory,
    DATABASE_URL: join(directory, 'db.sqlite'),
    ACCESS_PASSCODE: PASSCODE,
    DEPLOYMENT_DRAIN_FILE: drainFile,
    API_ALLOWED_ORIGINS: undefined,
    API_TRUST_PROXY: undefined,
  });
  return {
    ...h,
    drainFile,
    close: async () => {
      await h.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
const auth = `Bearer ${PASSCODE}`;

describe('Read-only deployment readiness and a file barrier owned by the release controller', () => {
  it('requires authentication, reports read-only readiness and rejects new writes/WS while preserving existing sessions', async () => {
    const h = await deployment();
    let socket: ReturnType<typeof io> | undefined;
    try {
      const server = h.app.getHttpServer();
      await request(server).get('/api/deployment/status').expect(401);
      const calls = [...h.provider.calls];
      const initial = await request(server)
        .get('/api/deployment/status')
        .set('Authorization', auth)
        .expect(200);
      expect(initial.body).toMatchObject({
        ready: true,
        idle: true,
        draining: false,
        inFlightHTTP: 0,
        activeWS: 0,
        credentialAuth: 0,
        readiness: { database: true, provider: true, image: true },
      });
      expect(h.provider.calls).toEqual(calls);
      const unlocked = await request(server)
        .post('/api/access/unlock')
        .send({ passcode: PASSCODE })
        .expect(200);
      socket = io(`${h.url}/events`, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        extraHeaders: { Cookie: unlocked.headers['set-cookie'][0].split(';')[0] },
      });
      await new Promise<void>((resolve, reject) => {
        socket!.once('connect', resolve);
        socket!.once('connect_error', reject);
      });
      const connected = await request(server)
        .get('/api/deployment/status')
        .set('Authorization', auth)
        .expect(200);
      expect(connected.body).toMatchObject({ activeWS: 1, idle: false });
      writeFileSync(h.drainFile, 'release barrier', { mode: 0o600 });
      const barrier = await request(server)
        .get('/api/deployment/status')
        .set('Authorization', auth)
        .expect(200);
      expect(barrier.body).toMatchObject({ draining: true, activeWS: 1, idle: false });
      expect(socket.connected).toBe(true);
      const denied = await request(server)
        .post('/api/projects')
        .set('Authorization', auth)
        .send({ name: 'blocked', sourceType: 'empty' })
        .expect(503);
      expect(denied.body).toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
        sideEffectFree: true,
        retryable: true,
      });
      await request(server).post('/api/access/unlock').send({ passcode: PASSCODE }).expect(503);
      await request(server).get('/api/health').expect(200);
      await request(server).get('/api/system/version').set('Authorization', auth).expect(200);
      expect((await request(server).get('/api/projects').set('Authorization', auth)).body).toEqual(
        [],
      );
      const deniedSocket = io(`${h.url}/events`, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        extraHeaders: { Authorization: auth },
      });
      try {
        const error = await new Promise<Error>((resolve, reject) => {
          deniedSocket.once('connect_error', resolve);
          deniedSocket.once('connect', () => reject(new Error('barrier admitted websocket')));
        });
        expect(error.message).toBe('websocket error');
      } finally {
        deniedSocket.disconnect();
      }
      socket.disconnect();
      await vi.waitFor(async () =>
        expect(
          (await request(server).get('/api/deployment/status').set('Authorization', auth)).body,
        ).toMatchObject({ draining: true, idle: true, inFlightHTTP: 0, activeWS: 0 }),
      );
      unlinkSync(h.drainFile);
      await request(server)
        .post('/api/projects')
        .set('Authorization', auth)
        .send({ name: 'after barrier', sourceType: 'empty' })
        .expect(202);
    } finally {
      socket?.disconnect();
      await h.close();
    }
  });

  it('counts live HTTP streams until close; the status request itself and health never make idle false', async () => {
    const h = await deployment();
    const controller = new AbortController();
    let response: Response | undefined;
    try {
      response = await fetch(`${h.url}/api/sse`, {
        headers: { Authorization: auth },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const active = await request(h.app.getHttpServer())
        .get('/api/deployment/status')
        .set('Authorization', auth)
        .expect(200);
      expect(active.body).toMatchObject({ idle: false, inFlightHTTP: 1 });
      controller.abort();
      await vi.waitFor(async () =>
        expect(
          (
            await request(h.app.getHttpServer())
              .get('/api/deployment/status')
              .set('Authorization', auth)
          ).body,
        ).toMatchObject({ idle: true, inFlightHTTP: 0 }),
      );
    } finally {
      controller.abort();
      await response?.body?.cancel().catch(() => undefined);
      await h.close();
    }
  });

  it('reports real SQLite blockers for running and preparing tasks, queued automation, cloning and pending allocation without exposing records', async () => {
    const h = await deployment();
    try {
      const server = h.app.getHttpServer();
      const project = await request(server)
        .post('/api/projects')
        .set('Authorization', auth)
        .send({ name: 'deployment fixture', sourceType: 'empty' })
        .expect(202);
      const db = h.app.get<Db>(DATABASE);
      db.run(
        sql`insert into sandboxes(id,project_id,runtime,status,headless,created_at,updated_at) values ('preparing',${project.body.id},'claude-code','preparing-workspace',0,1,1),('running',${project.body.id},'claude-code','running',0,1,1),('stopped',${project.body.id},'claude-code','stopped',0,1,1)`,
      );
      db.run(
        sql`insert into agent_tasks(id,sandbox_id,runtime,job_handle,log_path,timeout_ms,started_at) values ('agent-running','running','claude-code','{}','/synthetic/logs',60000,1)`,
      );
      db.run(
        sql`insert into automations(id,project_id,name,runtime_id,prompt,schedule_kind,schedule_config,timezone,created_at,updated_at) values ('automation',${project.body.id},'pending schedule','claude-code','synthetic','hourly','{}','UTC',1,1)`,
      );
      db.run(
        sql`insert into automation_runs(id,automation_id,triggered_at,status) values ('queued','automation',1,'pending')`,
      );
      db.run(
        sql`insert into resource_allocations(id,sandbox_id,cores_reserved,ram_mb_reserved,disk_mb_reserved,allocated_at) values ('reserved','preparing',1,512,512,1)`,
      );
      db.run(
        sql`update projects set source_type='git',repo_url='https://github.com/example/repo.git',clone_status='cloning' where id=${project.body.id}`,
      );
      const result = await request(server)
        .get('/api/deployment/status')
        .set('Authorization', auth)
        .expect(200);
      expect(result.body).toMatchObject({
        idle: false,
        blockers: {
          sandboxes: 2,
          agentTasks: 1,
          automationRuns: 1,
          enabledAutomations: 1,
          resourceAllocations: 1,
          cloningProjects: 1,
          projectCleanupJobs: 0,
        },
      });
      expect(JSON.stringify(result.body)).not.toContain(project.body.id);
      expect(JSON.stringify(result.body)).not.toContain('source_url');
      db.run(sql`update sandboxes set status='stopped'`);
      db.run(sql`update agent_tasks set status='succeeded',finished_at=2`);
      db.run(sql`update automation_runs set status='success',completed_at=2`);
      db.run(sql`update automations set enabled=0`);
      db.run(sql`update resource_allocations set reconciliation_status='confirmed'`);
      db.run(sql`update projects set clone_status='ready'`);
      expect(
        (await request(server).get('/api/deployment/status').set('Authorization', auth)).body,
      ).toMatchObject({ idle: false, blockers: { resourceAllocations: 1 } });
      db.run(sql`update resource_allocations set released_at=2`);
      db.run(
        sql`insert into sandbox_project_cleanup_jobs(sandbox_id,provider) values ('cleanup','aio')`,
      );
      expect(
        (await request(server).get('/api/deployment/status').set('Authorization', auth)).body,
      ).toMatchObject({ idle: false, blockers: { projectCleanupJobs: 1 } });
      db.run(sql`delete from sandbox_project_cleanup_jobs`);
      expect(
        (await request(server).get('/api/deployment/status').set('Authorization', auth)).body.idle,
      ).toBe(true);
      db.run(sql`update image_manifests set is_active=0`);
      expect(
        (await request(server).get('/api/deployment/status').set('Authorization', auth)).body,
      ).toMatchObject({ ready: false, readiness: { image: false } });
    } finally {
      await h.close();
    }
  });

  it('keeps failed auth resource disposal as an idle blocker until cleanup really succeeds', async () => {
    const h = await deployment();
    const dispose = deferred<void>();
    try {
      const app = h.app.get(RuntimeApplicationService);
      const store = h.app.get(AuthSessionStore);
      store.put({
        runtimeId: 'claude-code',
        challengeRef: 'deployment-auth',
        expiresAt: new Date(Date.now() + 60000),
        status: 'pending',
        challenge: AuthChallenge.create({
          challengeRef: 'deployment-auth',
          method: 'setup-token',
          kind: 'paste-prompt',
          instructions: 'synthetic auth',
        }),
        session: {
          homeDir: '/synthetic',
          readFile: async () => '',
          pty: {
            ref: 'synthetic',
            onData: () => {},
            onExit: () => {},
            write: () => {},
            resize: () => {},
            detach: () => {},
            kill: async () => {},
          },
          dispose: async () => dispose.promise,
        },
      });
      const server = h.app.getHttpServer();
      expect(
        (await request(server).get('/api/deployment/status').set('Authorization', auth)).body,
      ).toMatchObject({ idle: false, credentialAuth: 1 });
      const cancel = app.cancelAuth('claude-code', 'deployment-auth');
      expect(store.entries()).toHaveLength(0);
      expect(
        (await request(server).get('/api/deployment/status').set('Authorization', auth)).body,
      ).toMatchObject({ idle: false, credentialAuth: 1 });
      dispose.resolve();
      await cancel;
      expect(
        (await request(server).get('/api/deployment/status').set('Authorization', auth)).body,
      ).toMatchObject({ idle: true, credentialAuth: 0 });
    } finally {
      dispose.resolve();
      await h.close();
    }
  });

  it('does not report readiness when the existing database has a foreign-key violation', async () => {
    const h = await deployment();
    try {
      const db = h.app.get<Db>(DATABASE);
      db.run(sql`PRAGMA foreign_keys=OFF`);
      db.run(
        sql`insert into agent_tasks(id,sandbox_id,runtime,job_handle,status,log_path,timeout_ms,started_at,finished_at) values ('orphan','missing','claude-code','{}','succeeded','/synthetic/logs',60000,1,2)`,
      );
      db.run(sql`PRAGMA foreign_keys=ON`);
      const result = await request(h.app.getHttpServer())
        .get('/api/deployment/status')
        .set('Authorization', auth)
        .expect(200);
      expect(result.body).toMatchObject({ ready: false, readiness: { database: false } });
    } finally {
      await h.close();
    }
  });
});
