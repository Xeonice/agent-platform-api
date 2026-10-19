import 'reflect-metadata';
import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fromEpochMs } from '@platform/shared-kernel';
import {
  bootstrapIndependentColdBusiness,
  type ColdBusinessBootstrapInput,
} from '../../../apps/api/src/platform/persistence/cold-business-bootstrap';
import {
  coordinatorWriterControl,
  fenceCoordinatorConnection,
} from '../../../apps/api/src/platform/persistence/coordinator-lease';
import { assertControlMetadataBusinessCompatibility } from '../../../apps/api/src/platform/persistence/control-metadata-schema-bridge';
import { upgradeDigest } from '../../../apps/api/src/platform/upgrade/upgrade-trust';
import { useEnv } from '../../support/strict-ports';

let directory: string, input: ColdBusinessBootstrapInput, restore: () => void;
const clock = { now: () => fromEpochMs(Date.now()) },
  ids = { next: randomUUID };
function sealArtifact() {
  const files: Array<Record<string, unknown>> = [];
  function walk(folder: string) {
    for (const name of readdirSync(folder).sort()) {
      const file = join(folder, name),
        stat = lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else {
        const bytes = readFileSync(file);
        files.push({
          path: relative(input.coordinatorArtifactRoot, file),
          mode: stat.mode & 0o777,
          bytes: bytes.length,
          digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  }
  walk(join(input.coordinatorArtifactRoot, 'api'));
  writeFileSync(
    join(input.coordinatorArtifactRoot, 'upgrade-artifact.json'),
    JSON.stringify({
      files,
      components: { coordinator: { artifactDigest: upgradeDigest(files) } },
    }),
    { mode: 0o600 },
  );
}
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'independent-cold-business-')));
  const root = join(directory, 'artifact');
  mkdirSync(join(root, 'api'), { recursive: true, mode: 0o700 });
  cpSync(resolve('drizzle'), join(root, 'api/drizzle'), { recursive: true });
  for (const child of ['business', 'ledger']) mkdirSync(join(directory, child), { mode: 0o700 });
  input = {
    instanceId: 'cold-business-sqlite-fixture',
    businessPath: join(directory, 'business/platform.db'),
    controlPath: join(directory, 'ledger/control.db'),
    migrationsFolder: join(root, 'api/drizzle'),
    coordinatorArtifactRoot: root,
    deadline: Date.now() + 30000,
  };
  restore = useEnv({
    UPGRADE_CONTROL_DATABASE_PATH: undefined,
    PLATFORM_INSTANCE_ID: input.instanceId,
    COORDINATOR_GENERATION: undefined,
    COORDINATOR_WRITER_FENCE_VALID: undefined,
  });
  sealArtifact();
});
afterEach(() => {
  restore();
  rmSync(directory, { force: true, recursive: true });
});

// Actual original migration SQL, durable file SQLite and production writer
// fencing. The small attested artifact is a test input, not a Native package.
describe('fresh independent business initialization before any task is admitted', () => {
  it('applies exactly the original 29 business migrations and releases the real temporary writer before normal generation2', async () => {
    const receipt = await bootstrapIndependentColdBusiness(input, { clock, ids });
    const { receiptDigest, ...facts } = receipt;
    expect(upgradeDigest(facts)).toBe(receiptDigest);
    expect(receipt.temporaryWriter).toEqual({ generation: 1, fence: 1, expires_at: 0 });
    const business = new Database(input.businessPath),
      ledger = new Database(input.controlPath, { readonly: true });
    try {
      expect(business.prepare('SELECT count(*) n FROM __drizzle_migrations').get()).toEqual({
        n: 29,
      });
      expect(business.pragma('table_info(upgrade_steps)')).not.toContainEqual(
        expect.objectContaining({ name: 'evidence_digest' }),
      );
      expect(business.prepare('SELECT count(*) n FROM sandboxes').get()).toEqual({ n: 0 });
      expect(ledger.prepare('SELECT confirmed_release,ready FROM upgrade_instances').get()).toEqual(
        { confirmed_release: null, ready: 0 },
      );
      expect(receipt.confirmed).toBe(false);
      const writer = fenceCoordinatorConnection(business, input.instanceId, clock, ids),
        control = coordinatorWriterControl(writer);
      try {
        expect(control.generation).toBe(2);
        expect(control.fence).toBe(2);
        control.assert();
        process.env.UPGRADE_CONTROL_DATABASE_PATH = input.controlPath;
        expect(() =>
          assertControlMetadataBusinessCompatibility(
            writer,
            input.migrationsFolder,
            input.instanceId,
          ),
        ).not.toThrow();
        control.release();
      } finally {
        writer.close();
      }
    } finally {
      if (business.open) business.close();
      ledger.close();
    }
    await expect(bootstrapIndependentColdBusiness(input, { clock, ids })).rejects.toThrow(
      'COLD_BOOTSTRAP_EXISTING_DATABASE_FORBIDDEN',
    );
  });
  it('refuses any preexisting database even when it is an empty file', async () => {
    writeFileSync(input.businessPath, '', { mode: 0o600 });
    await expect(bootstrapIndependentColdBusiness(input, { clock, ids })).rejects.toThrow(
      'COLD_BOOTSTRAP_EXISTING_DATABASE_FORBIDDEN',
    );
    expect(readFileSync(input.businessPath).length).toBe(0);
    expect(existsSync(input.controlPath)).toBe(false);
  });
  it('preserves a preexisting WAL sidecar instead of opening it as an empty new installation', async () => {
    const foreign = Buffer.from('foreign WAL must remain untouched');
    writeFileSync(input.businessPath + '-wal', foreign, { mode: 0o600 });
    await expect(bootstrapIndependentColdBusiness(input, { clock, ids })).rejects.toThrow(
      'COLD_BOOTSTRAP_EXISTING_DATABASE_FORBIDDEN',
    );
    expect(readFileSync(input.businessPath + '-wal')).toEqual(foreign);
    expect(existsSync(input.businessPath)).toBe(false);
  });
  it('refuses a changed original migration even if the caller reseals its artifact metadata', async () => {
    const migration = join(input.migrationsFolder, '0029_upgrade_control_fast_path.sql');
    writeFileSync(migration, readFileSync(migration, 'utf8') + '\n-- changed SQL bytes\n');
    sealArtifact();
    await expect(bootstrapIndependentColdBusiness(input, { clock, ids })).rejects.toThrow(
      'COLD_BOOTSTRAP_MIGRATIONS_UNREVIEWED',
    );
    expect(existsSync(input.businessPath)).toBe(false);
  });
  it('refuses a modified artifact before opening either database', async () => {
    writeFileSync(join(input.migrationsFolder, '0029_upgrade_control_fast_path.sql'), 'SELECT 1;');
    await expect(bootstrapIndependentColdBusiness(input, { clock, ids })).rejects.toThrow(
      'INSTALLED_ARTIFACT_CHANGED',
    );
    expect(existsSync(input.businessPath)).toBe(false);
    expect(existsSync(input.controlPath)).toBe(false);
  });
  it('rejects expired budgets and symlinked database directories without clearing any state', async () => {
    await expect(
      bootstrapIndependentColdBusiness({ ...input, deadline: Date.now() }, { clock, ids }),
    ).rejects.toThrow('COLD_BOOTSTRAP_DEADLINE_EXPIRED');
    const target = join(directory, 'aliased');
    symlinkSync(join(directory, 'business'), target);
    await expect(
      bootstrapIndependentColdBusiness(
        { ...input, businessPath: join(target, 'platform.db') },
        { clock, ids },
      ),
    ).rejects.toThrow('COLD_BOOTSTRAP_DIRECTORY_INSECURE');
    expect(existsSync(input.businessPath)).toBe(false);
    expect(existsSync(input.controlPath)).toBe(false);
  });
});
