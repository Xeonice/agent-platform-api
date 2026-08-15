import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DATABASE } from '@platform/shared-kernel';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AppModule } from '../../src/app.module';
import {
  createDockerClient,
  isDockerAvailable,
} from '../../../../packages/modules/sandbox/src/infrastructure/providers/docker/docker-client';
import { RuntimeReconciler } from '../../../../packages/modules/sandbox/src/infrastructure/reconcile/runtime-reconciler';
import { getSharedBoxliteRuntime } from '../../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-runtime';
import { sandboxes } from '../../../../packages/modules/sandbox/src/infrastructure/persistence/schema/sandbox.sqlite';

/**
 * Startup orphan reconciler (docs/backend/13 §4). A crash between provider
 * `create()` and the DB write leaves a platform-managed runtime entity with no DB
 * record; the reconciler reaps those. This drives `reconcile()` directly against
 * REAL orphans: a docker container and (when BoxLite is available) a micro-VM,
 * both name/label-tagged `platform-*` with a sandboxId absent from the DB. Asserts
 * orphans are destroyed and a KNOWN (in-DB) container is preserved.
 *
 * docker-required (skips loudly if the daemon is down); the boxlite orphan case
 * additionally requires the BoxLite binary + local registry image.
 */
const IMAGE = 'alpine:3.20';
const REGISTRY = process.env.SANDBOX_BOXLITE_REGISTRY ?? 'localhost:5001';
const BOXLITE_IMAGE = `${REGISTRY}/agent-infra/sandbox:latest`;
const docker = createDockerClient();
const dockerUp = await isDockerAvailable(docker).catch(() => false);

const SANDBOX_PKG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/modules/sandbox/package.json',
);
function boxliteBinaryPresent(): boolean {
  try {
    createRequire(SANDBOX_PKG)('@boxlite-ai/boxlite');
    return true;
  } catch {
    return false;
  }
}
async function registryServingImage(): Promise<boolean> {
  try {
    const res = await fetch(`http://${REGISTRY}/v2/agent-infra/sandbox/tags/list`);
    if (!res.ok) return false;
    const body = (await res.json()) as { tags?: string[] };
    return Array.isArray(body.tags) && body.tags.includes('latest');
  } catch {
    return false;
  }
}
const boxliteReady = dockerUp && boxliteBinaryPresent() && (await registryServingImage());

if (!dockerUp) {
  console.warn(
    '\n[33m[reaper.e2e] SKIPPED — docker daemon unreachable (startup orphan reaper needs a live runtime).[0m\n',
  );
}

let app: INestApplication;
let reconciler: RuntimeReconciler;
let db: BetterSQLite3Database<Record<string, never>>;
const createdContainers = new Set<string>();
const createdBoxIds = new Set<string>();

async function pull(image: string): Promise<void> {
  await new Promise<void>((res, rej) => {
    docker.pull(image, (err: unknown, stream: NodeJS.ReadableStream) => {
      if (err) return rej(err instanceof Error ? err : new Error(String(err)));
      docker.modem.followProgress(stream, (e: unknown) =>
        e ? rej(e instanceof Error ? e : new Error(String(e))) : res(),
      );
    });
  });
}

async function makeOrphanContainer(name: string, sandboxId: string): Promise<void> {
  const c = await docker.createContainer({
    name,
    Image: IMAGE,
    Cmd: ['tail', '-f', '/dev/null'],
    Labels: { 'platform.managed': 'true', 'platform.provider': 'aio', 'platform.sandboxId': sandboxId },
  });
  createdContainers.add(name);
  await c.start();
}

async function containerExists(name: string): Promise<boolean> {
  return docker
    .getContainer(name)
    .inspect()
    .then(() => true)
    .catch(() => false);
}

beforeAll(async () => {
  if (!dockerUp) return;
  process.env.DATABASE_URL = ':memory:';
  await pull(IMAGE);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  reconciler = app.get(RuntimeReconciler);
  db = app.get<BetterSQLite3Database<Record<string, never>>>(DATABASE);
}, 60_000);

afterAll(async () => {
  for (const name of createdContainers) {
    await docker.getContainer(name).remove({ force: true }).catch(() => undefined);
  }
  if (boxliteReady) {
    const rt = await getSharedBoxliteRuntime().catch(() => null);
    for (const id of createdBoxIds) await rt?.remove(id, true).catch(() => undefined);
  }
  await app?.close();
});

describe.skipIf(!dockerUp)('RuntimeReconciler (startup orphan reaper)', () => {
  it('reaps a DB-less orphan container but preserves a known (in-DB) one', async () => {
    const orphanId = `orphan-${Date.now()}`;
    const keptId = `kept-${Date.now()}`;
    const orphanName = `platform-aio-${orphanId}`;
    const keptName = `platform-aio-${keptId}`;

    // insert a DB row for the "kept" sandbox so its container is NOT an orphan.
    db.insert(sandboxes)
      .values({
        id: keptId,
        projectId: 'prj-reaper',
        runtime: 'claude-code',
        headless: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    await makeOrphanContainer(orphanName, orphanId);
    await makeOrphanContainer(keptName, keptId);

    const result = await reconciler.reconcile();
    expect(result.removedContainers).toBeGreaterThanOrEqual(1);

    expect(await containerExists(orphanName)).toBe(false); // DB-less → reaped
    expect(await containerExists(keptName)).toBe(true); // in DB → preserved
    createdContainers.delete(orphanName);
  }, 60_000);

  it.skipIf(!boxliteReady)('reaps a DB-less orphan boxlite micro-VM', async () => {
    const orphanId = `orphan-bl-${Date.now()}`;
    const rt = await getSharedBoxliteRuntime();
    const box = await rt.create(
      { image: BOXLITE_IMAGE, memoryMib: 2048, cpus: 2, autoRemove: false, detach: true },
      `platform-boxlite-${orphanId}`,
    );
    createdBoxIds.add(box.id);

    const before = (await rt.listInfo()).some((b) => b.id === box.id);
    expect(before).toBe(true);

    const result = await reconciler.reconcile();
    expect(result.removedBoxes).toBeGreaterThanOrEqual(1);

    const after = (await rt.listInfo()).some((b) => b.id === box.id);
    expect(after).toBe(false); // DB-less micro-VM → reaped
    createdBoxIds.delete(box.id);
  }, 120_000);
});
