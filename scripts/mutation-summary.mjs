#!/usr/bin/env node
// 把 Stryker 的 json 报告压成一段 Markdown，喂给 GitHub 的 job summary（29 §3.3.4）。
//
// ⛔ **它永远 exit 0。** CI 的两条变异路径都不阻断合并（29 §3.3.3 第 1 条）：等价变异体
// 让 100% 永不可达，任何阈值都只会逼人写无意义的测试去凑分数。这里只负责把数字摆出来。
//
//   node scripts/mutation-summary.mjs reports/mutation/full.json
//   node scripts/mutation-summary.mjs reports/mutation      # 目录：取里面最新的那份
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const target = process.argv[2] ?? 'reports/mutation';

function resolveReport(p) {
  if (!statSync(p, { throwIfNoEntry: false })?.isDirectory()) return p;
  const candidates = readdirSync(p)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(p, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (candidates.length === 0) throw new Error(`no json report under ${p}`);
  return candidates[0];
}

let report;
let reportPath;
try {
  reportPath = resolveReport(target);
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (err) {
  // 报告读不到本身就是信息（跑挂了 / 没有可变异的文件），但不该让 job 红。
  process.stdout.write(`⚠️ 没读到报告（\`${target}\`）：${err.message}\n`);
  process.exit(0);
}

const tally = {};
const perFile = [];
for (const [file, { mutants }] of Object.entries(report.files ?? {})) {
  const f = {
    file,
    total: mutants.length,
    killed: 0,
    survived: 0,
    noCoverage: 0,
    timeout: 0,
    ignored: 0,
  };
  for (const m of mutants) {
    tally[m.status] = (tally[m.status] ?? 0) + 1;
    if (m.status === 'Killed') f.killed++;
    else if (m.status === 'Survived') f.survived++;
    else if (m.status === 'NoCoverage') f.noCoverage++;
    else if (m.status === 'Timeout') f.timeout++;
    else if (m.status === 'Ignored') f.ignored++;
  }
  f.covered = f.killed + f.survived + f.timeout;
  f.score = f.covered > 0 ? ((f.killed + f.timeout) / f.covered) * 100 : null;
  perFile.push(f);
}

const sum = (k) => perFile.reduce((a, f) => a + f[k], 0);
const covered = sum('covered');
const detected = sum('killed') + sum('timeout');
const valid = covered + sum('noCoverage');
const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');

const out = [];
// ⛔ 不打大标题：调用方（两个 job 的 summary 步骤）各自写自己的标题，
// 这里只出正文，免得 job summary 里出现两级重复的 `## 变异测试`。
out.push(`报告：\`${reportPath}\` · 文件 ${perFile.length} · 变异体 ${sum('total')}`);
out.push('');
out.push('| 指标 | 值 |');
out.push('| --- | ---: |');
out.push(`| ⭐ 变异分数（仅已覆盖） | **${pct(detected, covered)}** |`);
out.push(`| 变异分数（含未覆盖，不含 Ignored） | ${pct(detected, valid)} |`);
for (const [status, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  out.push(`| ${status} | ${n} |`);
}
out.push('');
out.push(
  '> ⛔ 不设分数门禁（29 §3.3.3 第 1 条）：等价变异体让 100% 永不可达，绝对阈值只会逼人凑分数。看趋势与热点。',
);
out.push(
  '> ⚠️ 只跑了 unit 层 —— integration 因 better-sqlite3 在插桩沙箱里 SIGSEGV 而进不来，e2e 太慢。',
);
out.push('> 所以 NoCoverage 多数不是「没测试」，是「归 integration / e2e 管」。');

const hotspots = perFile
  .filter((f) => f.covered >= 10 && f.score !== null)
  .sort((a, b) => a.score - b.score)
  .slice(0, 10);
if (hotspots.length > 0) {
  out.push('');
  out.push('### 存活热点（已覆盖变异体 ≥10，按已覆盖分数升序）');
  out.push('');
  out.push('| 已覆盖分数 | 存活/已覆盖 | 未覆盖 | 文件 |');
  out.push('| ---: | ---: | ---: | --- |');
  for (const f of hotspots) {
    out.push(
      `| ${f.score.toFixed(1)}% | ${f.survived}/${f.covered} | ${f.noCoverage} | \`${f.file}\` |`,
    );
  }
}

process.stdout.write(`${out.join('\n')}\n`);
