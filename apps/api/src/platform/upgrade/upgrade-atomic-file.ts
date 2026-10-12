import { UuidIdGenerator } from '../time/uuid-id-generator';
import { lstat, open, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { canonicalUpgrade, requireUpgrade } from './upgrade-trust';

export async function writeInstalledBinding(path: string, value: unknown): Promise<void> {
  requireUpgrade(isAbsolute(path), 'INSTALLED_BINDING_PATH_REQUIRED');
  const parent = dirname(path),
    stat = await lstat(parent);
  requireUpgrade(
    stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
    'INSECURE_INSTALLED_BINDING',
  );
  const temp = join(parent, '.' + new UuidIdGenerator().next());
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(canonicalUpgrade(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  const dir = await open(parent, 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
