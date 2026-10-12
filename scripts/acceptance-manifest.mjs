#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const apiRoot = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(apiRoot, '../docs/product/requirements');
const domains = ['WB', 'PRJ', 'LCH', 'SBX', 'AUTH', 'CRD', 'IMG', 'AUT', 'SYS', 'ACC', 'DEP', 'UPG'];
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
const upgradePlan = resolve(apiRoot, '../docs/testing/changes/2026-10-10-不停机升级与沙箱续接测试计划.md');
const upgradeRows = [...readFileSync(upgradePlan, 'utf8').matchAll(/^\| (AC-UPG-\d+\.\d+) \| ([^|]+) \| ([^|]+) \|$/gm)];
const upgradeCriteria = rows.filter(row => row.domain === 'UPG');
if (upgradeCriteria.length !== 52 || upgradeRows.length !== 52 || new Set(upgradeRows.map(match => match[1])).size !== 52)
  throw new Error('UPG specification and independent test plan must contain the same unique 52 ACs');
for (const match of upgradeRows) {
  const row = upgradeCriteria.find(candidate => candidate.id === match[1]);
  if (!row) throw new Error(`Unknown UPG test-plan criterion ${match[1]}`);
  const scenarios = match[2].match(/\b[FBCIN]\d{2}\b/g)?.map(value => value.trim()) ?? [];
  if (!scenarios.length) throw new Error(`Missing UPG required layers ${match[1]}`);
  row.requiredVerification = {
    source: relative(apiRoot, upgradePlan),
    scenarios,
    layers: [...new Set(scenarios.map(id => ({F:'web',B:'backend',C:'contract',I:'real-browser-api-controller',N:'native-runtime'})[id[0]]))],
    actualExpected: match[3].trim(),
    status: 'not-run',
    meaning: 'A source mapping or passed API unit/protocol test does not satisfy missing shared/browser/native layers. Only a report for the exact artifact input may confirm this AC.',
  };
}
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
  specification: 'docs/product/requirements — approved Given/When/Then',
  totalAcceptanceCriteria: rows.length,
  counts: Object.fromEntries(
    domains.map((domain) => [domain, rows.filter((row) => row.domain === domain).length]),
  ),
  execution: 'Not inferred from this manifest. API: pnpm test:acceptance. UPG also requires the mapped real e2e-contract pnpm test:upgrade and native/verify-upgrade.mjs evidence for exact inputs. Planned/scenario-defined and API test totals are not 52 ACs passed.',
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
