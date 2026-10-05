import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const reports = resolve(root, 'reports/acceptance');
mkdirSync(reports, { recursive: true });
const rounds = [
  { name: 'non-protocol', projects: ['pure', 'service', 'sqlite'] },
  { name: 'protocol', projects: ['protocol'] },
];
const results = [];
const assertionEvidence = resolve(reports, 'assertion-evaluations.jsonl');
writeFileSync(assertionEvidence, '');
for (const round of rounds) {
  const output = resolve(reports, `${round.name}.json`);
  const run = spawnSync(
    process.execPath,
    [
      resolve(root, 'scripts/vitest-capped.mjs'),
      'run',
      ...round.projects.flatMap((project) => ['--project', project]),
      '--reporter=json',
      `--outputFile=${output}`,
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, ACCEPTANCE_ASSERTION_EVIDENCE: assertionEvidence },
    },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
  results.push(JSON.parse(readFileSync(output, 'utf8')));
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)],
  );
}
const sources = files(resolve(root, 'acceptance'))
  .filter((file) => file.endsWith('.spec.ts'))
  .sort();
const records = results.flatMap((result) => result.testResults);
const tests = records.flatMap((result) => result.assertionResults);
const evaluations = readFileSync(assertionEvidence, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
if (evaluations.length !== tests.length)
  throw new Error('Actual matcher evidence must contain one record for each executed test');
const report = {
  node: process.version,
  files: records.length,
  tests: tests.length,
  passed: tests.filter((test) => test.status === 'passed').length,
  failed: tests.filter((test) => test.status === 'failed').length,
  skipped: tests.filter((test) => !['passed', 'failed'].includes(test.status)).length,
  runtimeMatcherEvaluations: evaluations.reduce((count, row) => count + row.evaluations, 0),
  runtimeMatcherMeaning:
    'Actual Vitest matcher calls in each completed test; polling retry evaluations count too. This is distinct from test count and source clauses.',
  sourceExpectationSites: sources.reduce(
    (total, file) =>
      total + [...readFileSync(file, 'utf8').matchAll(/\bexpect\s*(?:\.\w+\s*)?\(/g)].length,
    0,
  ),
  expectationSitesMeaning:
    'Static source clauses; parameterized execution may evaluate a clause multiple times. This is not a runtime assertion count.',
  boundaries:
    'Actual production SQLite/services/Nest/HTTP/MCP/WS, synthetic external provider/vendor fixture, native child stdout and local Git smart HTTP. No real OAuth account or dedicated Docker/BoxLite provider claimed.',
  sourceHashes: Object.fromEntries(
    sources.map((file) => [
      relative(root, file),
      createHash('sha256').update(readFileSync(file)).digest('hex'),
    ]),
  ),
  executions: records.map((record) => ({
    file: relative(root, record.name),
    status: record.status,
    tests: record.assertionResults.length,
  })),
};
writeFileSync(
  resolve(root, 'acceptance/execution-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  `Actual acceptance execution: ${report.files} files, ${report.passed}/${report.tests} passed, ${report.skipped} skipped.`,
);
