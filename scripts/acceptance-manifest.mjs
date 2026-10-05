#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const apiRoot = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(apiRoot, '../docs/design-v2/gap/product');
const domains = ['WB', 'PRJ', 'LCH', 'SBX', 'AUTH', 'CRD', 'IMG', 'AUT', 'SYS', 'ACC', 'DEP'];
const rows = [];
for (const domain of domains) {
  const source = resolve(sourceRoot, `${domain}.md`);
  let requirement = '';
  for (const [index, line] of readFileSync(source, 'utf8').split('\n').entries()) {
    const heading = line.match(/^###\s+(REQ-[A-Z]+-\d+)\s/);
    if (heading) requirement = heading[1];
    const match = line.match(/^\|\s*(AC-[A-Z]+-\d+\.\d+)/);
    if (!match) continue;
    const cells = line
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((cell) => cell.trim());
    rows.push({
      id: match[1],
      domain,
      requirement,
      source: `${relative(apiRoot, source)}:${index + 1}`,
      level: cells[1],
      given: cells[2],
      when: cells[3],
      then: cells[4],
      responsibility:
        cells[1] === 'API'
          ? 'backend'
          : ['组件', '视觉', 'a11y', '无障碍'].includes(cells[1])
            ? 'web'
            : 'shared',
      coverage: 'planned',
      scenarios: [],
    });
  }
}
if (new Set(rows.map((row) => row.id)).size !== rows.length)
  throw new Error('Duplicate AC IDs in approved specification');
const mappingsFile = resolve(apiRoot, 'acceptance/scenario-map.json');
const mappings = existsSync(mappingsFile) ? JSON.parse(readFileSync(mappingsFile, 'utf8')) : [];
for (const mapping of mappings) {
  if (!existsSync(resolve(apiRoot, mapping.file)))
    throw new Error(`Scenario source missing: ${mapping.file}`);
  for (const id of mapping.acs) {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`Unknown specification AC ${id}`);
    row.scenarios.push({
      file: mapping.file,
      purpose: mapping.purpose,
      relation: mapping.relation,
    });
    row.coverage = 'scenario-defined';
  }
}
const manifest = {
  specification: 'docs/design-v2/gap/product — approved Given/When/Then',
  totalAcceptanceCriteria: rows.length,
  counts: Object.fromEntries(
    domains.map((domain) => [domain, rows.filter((row) => row.domain === domain).length]),
  ),
  execution: 'Not inferred from this manifest. Run pnpm test:acceptance; planned is not passed.',
  rows,
};
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
const target = resolve(apiRoot, 'acceptance/manifest.json');
if (process.argv.includes('--check')) {
  if (!existsSync(target) || readFileSync(target, 'utf8') !== serialized)
    throw new Error('Acceptance manifest is out of date; run pnpm acceptance:manifest');
  console.log(
    `Acceptance mapping is current: ${rows.length} ACs; ${rows.filter((row) => row.scenarios.length > 0).length} have explicit scenario sources.`,
  );
} else {
  writeFileSync(target, serialized);
  console.log(
    `Wrote ${rows.length} specification ACs; unresolved mapping remains explicitly planned.`,
  );
}
