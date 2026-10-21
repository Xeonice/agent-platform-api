import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfirmedServiceReleaseSchema, type ConfirmedServiceRelease } from '@platform/contracts';
import { initialSourceActivation } from '../../../apps/api/src/platform/upgrade/upgrade-artifact-proof';
import { upgradeDigest } from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import { currentDatabase } from '../../support/sqlite';
import { useEnv } from '../../support/strict-ports';

let db: ReturnType<typeof currentDatabase>,
  store: UpgradeStore,
  directory: string,
  path: string,
  restore: () => void,
  initial: ConfirmedServiceRelease;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'upg-initial-source-')));
  path = join(directory, 'bootstrap-not-mounted', 'initial-release.json');
  restore = useEnv({
    PLATFORM_INSTANCE_ID: 'initial-source-anchor',
    UPGRADE_INITIAL_RELEASE_PATH: path,
  });
  db = currentDatabase();
  store = new UpgradeStore(db.sqlite, { now: () => new Date() }, { next: randomUUID });
  const component = {
    artifactDigest: upgradeDigest('artifact'),
    inputFingerprint: upgradeDigest('input'),
    sourceRevision: '1'.repeat(40),
    protocol: { min: 1, max: 2 },
  };
  initial = ConfirmedServiceReleaseSchema.parse({
    releaseId: '0.3.10',
    activationGeneration: 1,
    activatedAt: new Date().toISOString(),
    schema: 28,
    channel: 'test',
    components: {
      api: component,
      coordinator: component,
      owner: component,
      installer: component,
      web: { ...component, webRevision: '2'.repeat(40) },
    },
    commits: { api: '1'.repeat(40), project: '2'.repeat(40), web: '3'.repeat(40) },
    productionWebBinding: 'http://127.0.0.1:7000',
  });
  store.bootstrap(initial);
  // Only the durable source-anchor lookup is under test. No fabricated attempt
  // is accepted by the actual upgrade state machine or used as runtime proof.
  db.sqlite.exec(
    'DROP TABLE upgrade_attempts; CREATE TABLE upgrade_attempts(attempt_id TEXT PRIMARY KEY,instance_id TEXT,generation INTEGER,source_activation TEXT);',
  );
  add(initial, 1);
});
afterEach(async () => {
  db.sqlite.close();
  restore();
  await rm(directory, { recursive: true, force: true });
});
function add(release: unknown, generation: number, instance = store.instanceId) {
  db.sqlite
    .prepare('INSERT INTO upgrade_attempts VALUES(?,?,?,?)')
    .run(randomUUID(), instance, generation, JSON.stringify(release));
}
async function receipt(release: unknown) {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ release }), { mode: 0o600 });
}
describe('persisted bootstrap tuple remains the initial artifact anchor when its file is not mounted', () => {
  it('uses the accepted initial source snapshot and ignores foreign-instance rows', async () => {
    add({ invalid: 'another instance' }, 0, 'foreign-instance');
    await expect(initialSourceActivation(store)).resolves.toEqual(initial);
    await receipt(initial);
    await expect(initialSourceActivation(store)).resolves.toEqual(initial);
  });
  it('rejects conflicting persisted tuples or a visible changed receipt', async () => {
    await receipt({
      ...initial,
      components: {
        ...initial.components,
        web: { ...initial.components.web, webRevision: 'f'.repeat(40) },
      },
    });
    await expect(initialSourceActivation(store)).rejects.toThrow(
      'INITIAL_SOURCE_ACTIVATION_CHANGED',
    );
    await rm(path);
    add(
      {
        ...initial,
        components: {
          ...initial.components,
          api: { ...initial.components.api, inputFingerprint: upgradeDigest('other') },
        },
      },
      2,
    );
    await expect(initialSourceActivation(store)).rejects.toThrow(
      'INITIAL_SOURCE_ACTIVATION_CHANGED',
    );
  });
  it('rejects missing history, non-initial generations, or a source inconsistent with the confirmed bootstrap', async () => {
    db.sqlite.exec('DELETE FROM upgrade_attempts');
    await expect(initialSourceActivation(store)).rejects.toThrow(
      'INITIAL_SOURCE_ACTIVATION_UNKNOWN',
    );
    add({ ...initial, activationGeneration: 2 }, 1);
    await expect(initialSourceActivation(store)).rejects.toThrow(
      'INITIAL_SOURCE_ACTIVATION_UNKNOWN',
    );
    db.sqlite.exec('DELETE FROM upgrade_attempts');
    add({ ...initial, releaseId: '0.3.11' }, 1);
    await expect(initialSourceActivation(store)).rejects.toThrow(
      'INITIAL_SOURCE_ACTIVATION_CHANGED',
    );
  });
  it('does not treat a visible unsafe receipt or malformed persisted components as missing', async () => {
    await mkdir(join(path, '..'), { recursive: true });
    await symlink(join(directory, 'missing'), path);
    await expect(initialSourceActivation(store)).rejects.toThrow('INSECURE_RETAINED_ARTIFACT_FILE');
    await rm(path);
    db.sqlite.exec('DELETE FROM upgrade_attempts');
    add({ ...initial, components: {} }, 1);
    await expect(initialSourceActivation(store)).rejects.toThrow();
  });
});
