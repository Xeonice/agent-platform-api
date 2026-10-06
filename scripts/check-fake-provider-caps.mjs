import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

// The new protocol fixture exposes aio only. Compare its actual declaration with aio;
// no claim is made that this fixture validates the external Docker/BoxLite implementation.
const root = resolve(import.meta.dirname, '..');
function capabilities(file, className) {
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(root, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === className,
  );
  const property = declaration?.members.find(
    (node) => ts.isPropertyDeclaration(node) && node.name.getText(source) === 'capabilities',
  );
  let value = property?.initializer;
  while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value)))
    value = value.expression;
  if (!value || !ts.isObjectLiteralExpression(value))
    throw new Error(`Literal capability declaration missing in ${file}`);
  return Object.fromEntries(
    value.properties.map((node) => {
      if (
        !ts.isPropertyAssignment(node) ||
        ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.initializer.kind)
      )
        throw new Error(`Nonboolean capability in ${file}`);
      return [node.name.getText(source), node.initializer.kind === ts.SyntaxKind.TrueKeyword];
    }),
  );
}
const actual = capabilities(
  'packages/modules/sandbox/src/infrastructure/providers/aio/aio-sandbox.provider.ts',
  'AioSandboxProvider',
);
const fixture = capabilities('acceptance/support/external-provider.ts', 'ScriptedProvider');
if (JSON.stringify(actual) !== JSON.stringify(fixture))
  throw new Error('Protocol fixture capabilities drifted from aio');
console.log(
  'New aio protocol fixture capability declaration matches production. External provider execution is a separate gate.',
);
