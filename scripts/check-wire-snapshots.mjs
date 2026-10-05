import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..');
function stringValue(node) {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return stringValue(node.left) + stringValue(node.right);
  throw new Error('Protocol declaration must be a string literal or string concatenation');
}
function declaration(file, constant) {
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(root, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const row of statement.declarationList.declarations) {
      if (row.name.getText(source) === constant && row.initializer)
        return stringValue(row.initializer);
    }
  }
  throw new Error(`Missing ${constant} in ${file}`);
}
const pairs = [
  [
    'WS_PROTOCOL_CANONICAL',
    'packages/contracts/src/ws-protocol.ts',
    '../web/src/types/ws-protocol.ts',
  ],
  [
    'SSE_PROTOCOL_CANONICAL',
    'packages/contracts/src/sse-protocol.ts',
    '../web/src/types/sse-protocol.ts',
  ],
  [
    'WS_SCHEMA_HASH',
    'packages/contracts/src/ws-protocol.ts',
    '../web/src/lib/terminal/terminalSocket.ts',
  ],
  [
    'WS_TASKS_SCHEMA_HASH',
    'packages/contracts/src/ws-protocol.ts',
    '../web/src/lib/task/taskSocketConfig.ts',
  ],
  [
    'SSE_DIAGNOSE_SCHEMA_HASH',
    'packages/contracts/src/sse-protocol.ts',
    '../web/src/types/sse-protocol.ts',
  ],
];
const declarations = pairs.map(([constant, api, web]) => {
  const value = declaration(api, constant);
  if (value !== declaration(web, constant))
    throw new Error(`${constant} drifted between API and web`);
  return { constant, api, web, value, sha256: createHash('sha256').update(value).digest('hex') };
});
const report = {
  scope:
    'Verified declared WS/SSE canonical strings and handshake hashes; actual runtime frames are separately exercised by protocol and browser acceptance.',
  declarations,
};
writeFileSync(
  resolve(root, 'acceptance/wire-snapshots.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(`Verified ${declarations.length} actual API/web protocol declaration pairs.`);
