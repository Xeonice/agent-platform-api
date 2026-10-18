import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lint = new ESLint({ cwd: root, overrideConfigFile: resolve(root, 'eslint.config.mjs') });
const domainFile = resolve(root, 'packages/modules/project/src/domain/entities/project.entity.ts');
const pureEntry = resolve(root, 'packages/shared-kernel/src/pure.ts');
const infrastructureFile = resolve(
  root,
  'packages/modules/project/src/infrastructure/git/git-cloner.ts',
);

async function rules(code: string, filePath: string): Promise<(string | null)[]> {
  const results = await lint.lintText(code, { filePath });
  // A parser failure must not masquerade as successful architecture enforcement.
  expect(results.flatMap((result) => result.messages.filter((message) => message.fatal))).toEqual(
    [],
  );
  return results.flatMap((result) => result.messages.map((message) => message.ruleId));
}

describe('the actual architecture lint configuration', () => {
  it('permits pure domain primitives through the dedicated entry', async () => {
    expect(
      await rules("export { asProjectId } from '@platform/shared-kernel/pure';", domainFile),
    ).toEqual([]);
  }, 30_000);

  it('rejects the broad shared-kernel barrel in domain code', async () => {
    expect(
      await rules(
        "export { verifyInstalledArtifactTree } from '@platform/shared-kernel';",
        domainFile,
      ),
    ).toContain('@typescript-eslint/no-restricted-imports');
  });

  it('rejects direct Node IO in domain code', async () => {
    expect(await rules("export { readFile } from 'node:fs/promises';", domainFile)).toContain(
      '@typescript-eslint/no-restricted-imports',
    );
  });

  it('rejects relative kernel IO imports that bypass the package barrel', async () => {
    const target = resolve(root, 'packages/shared-kernel/src/fs/installed-artifact');
    const specifier = relative(dirname(domainFile), target).split('\\').join('/');
    expect(
      await rules(`export { verifyInstalledArtifactTree } from '${specifier}';`, domainFile),
    ).toContain('boundaries/element-types');
  });

  it('rejects IO reexports added to the pure entry itself', async () => {
    expect(
      await rules(
        "export { verifyInstalledArtifactTree } from './fs/installed-artifact';",
        pureEntry,
      ),
    ).toContain('boundaries/element-types');
  });

  it('continues to permit IO in infrastructure', async () => {
    expect(await rules("export { readFile } from 'node:fs/promises';", infrastructureFile)).toEqual(
      [],
    );
  });

  it('runs type-aware unsafe-value rules on production source', async () => {
    const violations = await rules(
      'export const value: any = JSON.parse("{}");',
      infrastructureFile,
    );
    expect(violations).toContain('@typescript-eslint/no-explicit-any');
    expect(violations).toContain('@typescript-eslint/no-unsafe-assignment');
  });

  it('rejects unchecked narrowing of external values', async () => {
    expect(
      await rules(
        'export function decode(value: unknown): string { return value as string; }',
        infrastructureFile,
      ),
    ).toContain('@typescript-eslint/no-unsafe-type-assertion');
  });

  it.each([
    [
      'export const value = {} as { present: boolean };',
      '@typescript-eslint/consistent-type-assertions',
    ],
    [
      'export function read(value?: string) { return value!; }',
      '@typescript-eslint/no-non-null-assertion',
    ],
    ['export const value = (1 as unknown) as string;', 'no-restricted-syntax'],
  ])('keeps syntax rules active in test source: %s', async (code, rule) => {
    expect(await rules(code, fileURLToPath(import.meta.url))).toContain(rule);
  });
});
