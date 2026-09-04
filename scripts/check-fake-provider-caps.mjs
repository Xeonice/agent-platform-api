#!/usr/bin/env node
/**
 * api 侧**取值镜像**检查（29 §3.7 的 api 镜像）—— 替身的能力位 ⟷ 真 provider 的声明。
 *
 * ── 它守的是什么 ────────────────────────────────────────────────────────────
 * `apps/api/test/e2e/_fakes.ts#makeFakeRegistry` 造出两个**与内置真 provider 同名**的
 * 替身（`aio` / `boxlite`）。它们的 `capabilities` 与
 * `packages/modules/sandbox/src/infrastructure/providers/{aio,boxlite}/*-sandbox.provider.ts`
 * 的 `readonly capabilities` **靠人手同步，此前没有任何机器在对**。
 *
 * ⛔ **「今天恰好相等」正是问题**：真 provider 改了一位而替身没跟，
 *   - **220 条 api e2e** 照绿 —— 它们跑的就是这个替身；
 *   - 主仓 **6 条真链路契约 e2e** 也照绿 —— `e2e-contract/server/start-api.ts` 为了在无
 *     docker 的 CI 里跑，把 provider registry 换成了 `makeFakeRegistry(...)`，于是它录到的
 *     `GET /api/providers` **就是这里的替身值**，不是真 provider 的值（29 §3.7.2 Q3）。
 *     ⇒ 那一层结构上够不着这条缝：**它把第二层替身当成了第一层的判据**。
 *
 * ── 判据：为什么是「逐位相等」而不是「替身只能更保守」────────────────────────
 * 先查过「有没有正当理由让它们不同」，答案是**有，但那些理由都不走这条路**（见下「刻意
 * 不管」）。对**注册表里那两个与真 provider 同名的替身**，判据只能是逐位相等，两个方向
 * 都不许漂：
 *   ① 这几位是**被当作真值消费**的：`GET /api/providers` 的响应体逐位来自它们
 *      （`sandbox-application.service.ts` 把 `p.capabilities.*` 直接铺进 DTO），而契约
 *      e2e 录的就是这份响应 ⇒ 替身漂哪个方向，录到的契约样本就假在哪个方向。
 *   ② 平台的**准入分支**按这几位分流（`assertCapabilities`：`spawnTty:false` 一律拒绝建
 *      沙箱；`create({require:{…}})` 的创建前静态校验；headless Task 的 409）。
 *      替身更保守 ⇒ e2e 走进一条线上不存在的拒绝分支；替身更宽松 ⇒ 拒绝分支从没被覆盖。
 *      **两个方向都坏**，所以「只能更保守」不成立。
 *
 * ── 判据是 per-provider 的，⛔ 不是「三方全等」──────────────────────────────
 * 今天 aio 与 boxlite 七位恰好相同，但那是**巧合，不是约定**：04 §8 的注册表是开放的，
 * 两个内置实现（docker 容器 / 微 VM）本来就可能长出不同的能力。所以本检查按**名字**
 * 逐个配对：`真 provider P.capabilities` ⟷ `替身注册表里叫 P 的那个的 capabilities`。
 * 将来 boxlite 支持了 snapshot 而 aio 没有，本检查会红在「boxlite.snapshot」这一位上，
 * 修法是**给替身分成两份 caps**（`makeFakeRegistry` 今天用同一个 `CAPS` 常量喂两个替身），
 * ⛔ **不是把真 provider 改回一致**。
 *
 * 真 provider 的名单也**不硬编码**：从 `provider-registry.ts` 构造函数注入的那几个类
 * 反查（AST 读构造参数类型 → 顺着 import 找到文件）。新增第三个内置 provider 会自动进入
 * 管辖，并在替身注册表缺它时报出来。
 *
 * ── ⛔ 刻意不管的三处（每一处都是「正当的不同」，管起来就成了误报机器）──────────
 *  1. **`makeNoHeadlessProvider()`**：`new FakeProvider('noheadless', {...CAPS, headlessTask:false})`
 *     —— 刻意关掉一位来测 409 降级分支。⭐ 它走的是**另一个名字**，没有冒充任何真
 *     provider ⇒ 天然在管辖外。这正是「先确认没有正当理由让它们不同」的答案：正当理由
 *     存在，但它有正当的表达方式，不需要为它放宽判据。
 *  2. **各 e2e 文件里的场景取值**（`registry-extension.e2e-spec.ts` 的 `spawnTty:false`、
 *     `agent-bootstrap.e2e-spec.ts` 的临时 caps 等）：按用例要走的分支挑的值，
 *     **不自称是镜像**（与 29 §3.7.3 对 web `providerCaps()` 的口径同源）。
 *  3. **`makeFakeRegistry` 的 `defaultProvider: 'aio'`**：真注册表的默认是**跟宿主平台走**的
 *     （`hostPreferredProvider()`：darwin ⇒ boxlite，否则 aio）。替身钉死 `'aio'` 是为了让
 *     e2e 与录制不随开发机操作系统变，是**刻意的不同**，不是漂移 ⇒ 不比。
 *
 * ⛔ **也不管 `builtin-providers.contract.spec.ts` 的 `expectedCapabilities` pin**：那份
 * 手抄件已经**有机器守着**了 —— 它自己就是断言，真 provider 一改它当场红（那正是回归 pin
 * 的用途）。在这里重复比一遍不增加任何防护力。⚠️ 但它解释了这条缝**为什么会长出来**：
 * 真 provider 改一位 ⇒ 那道 pin 红 ⇒ 有人把 pin 更新了 ⇒ **没有任何东西提醒他还有
 * `_fakes.ts#CAPS`** ⇒ 替身独自留在旧值上，全绿。本检查守的就是这最后一步。
 *
 * ── 手段与阻断性 ────────────────────────────────────────────────────────────
 * ⛔ **不用正则，走 TypeScript AST**：boxlite 的 `snapshot` 那一位上方有一大段注释写着
 * 「SDK 有完整快照 API」，正则会把注释里的词当成值，误报成 `true`（实际 `false`）。
 * 与主仓 `scripts/check-fixture-values.mjs` 同一条教训。
 *
 * ⚠️ **不是阻断门禁**（29 §3.3.4 / §3.7.3 同一条工程现实：新门禁第一周误伤就会被
 * `--no-verify` 绕过或直接关掉）。⛔ 不进 `.github/workflows/ci.yml` 的八步、不进 husky。
 * 手动跑：`node scripts/check-fake-provider-caps.mjs`。exit code 有意义，方便将来升级。
 *
 * ⚠️ 求值器只认字面量与顶层 const，读不出就**报「读不出」**，⛔ 不猜 —— 猜出来的值会让
 * 这份检查自己变成又一个替身。
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = resolve(HERE, '..');

const REGISTRY = join(
  API,
  'packages/modules/sandbox/src/infrastructure/registry/provider-registry.ts',
);
const FAKES = join(API, 'apps/api/test/e2e/_fakes.ts');

// ── typescript ──────────────────────────────────────────────────────────────
// 没装就 **exit 2 大声跳过**，⛔ 不静默 exit 0（那会让「没跑」看起来像「跑绿了」）。
const TS_PKG = join(API, 'node_modules', 'typescript', 'package.json');
if (!existsSync(TS_PKG)) {
  console.error(`✗ 找不到 typescript（${TS_PKG}）。先 pnpm install 再跑。⛔ 不当作通过。`);
  process.exit(2);
}
const ts = createRequire(TS_PKG)('typescript');

function parse(file) {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

/** 顶层 `const x = <init>` 的初始化表达式表。 */
function topLevelConsts(sf) {
  const env = new Map();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer !== undefined)
        env.set(d.name.text, d.initializer);
    }
  }
  return env;
}

/**
 * 极小字面量求值器：字符串/布尔字面量、对象字面量（含 `...spread`）、数组字面量、
 * 指向顶层 const 的标识符、`as` / 括号。其余一律 `undefined` ⇒ 调用方报「读不出」。
 */
function evalNode(node, env, depth = 0) {
  if (node === undefined || depth > 8) return undefined;
  if (
    ts.isAsExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isSatisfiesExpression?.(node)
  ) {
    return evalNode(node.expression, env, depth + 1);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isIdentifier(node)) return evalNode(env.get(node.text), env, depth + 1);
  if (ts.isArrayLiteralExpression(node)) {
    const out = [];
    for (const e of node.elements) {
      const v = evalNode(e, env, depth + 1);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out = {};
    for (const p of node.properties) {
      if (ts.isSpreadAssignment(p)) {
        const spread = evalNode(p.expression, env, depth + 1);
        // ⚠️ spread 读不出就整体读不出：把它当空对象会**悄悄丢掉几位**，
        // 然后比对结果看起来还很像回事 —— 那是最坏的一种假绿。
        if (spread === undefined || typeof spread !== 'object') return undefined;
        Object.assign(out, spread);
        continue;
      }
      if (!ts.isPropertyAssignment(p)) continue;
      const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
      if (key === undefined) continue;
      const v = evalNode(p.initializer, env, depth + 1);
      if (v === undefined) return undefined;
      out[key] = v;
    }
    return out;
  }
  return undefined;
}

/** class 里 `readonly <name> = <literal>` / `<name>: T = <literal>`。 */
function classProp(sf, name) {
  let found;
  const visit = (n) => {
    if (
      ts.isPropertyDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      found === undefined
    ) {
      found = evalNode(n.initializer, topLevelConsts(sf));
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

const problems = [];
const checked = [];

// ── 第一步：真 provider 的名单，从注册表构造函数反查 ──────────────────────────
// ⛔ 不硬编码 {aio, boxlite}：那样新增第三个内置 provider 时，这份检查会**安静地漏掉它**。
function builtinProviderFiles() {
  const sf = parse(REGISTRY);
  const imports = new Map(); // 局部类名 → 模块说明符
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const named = st.importClause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) imports.set(el.name.text, st.moduleSpecifier.text);
  }
  const out = new Map(); // 类名 → 绝对路径
  const visit = (n) => {
    if (ts.isConstructorDeclaration(n)) {
      for (const p of n.parameters) {
        const t = p.type;
        if (t === undefined || !ts.isTypeReferenceNode(t) || !ts.isIdentifier(t.typeName)) continue;
        const spec = imports.get(t.typeName.text);
        if (spec === undefined || !spec.startsWith('.')) continue;
        out.set(t.typeName.text, resolve(dirname(REGISTRY), `${spec}.ts`));
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

if (!existsSync(REGISTRY) || !existsSync(FAKES)) {
  console.error(`✗ 找不到 ${existsSync(REGISTRY) ? FAKES : REGISTRY}。⛔ 不当作通过。`);
  process.exit(2);
}

const builtins = builtinProviderFiles();
if (builtins.size === 0) {
  console.error(
    '✗ 从 provider-registry.ts 的构造函数里读不出任何内置 provider —— 结构变了？⛔ 不当作通过。',
  );
  process.exit(2);
}

/** 真 provider：name → { caps, file }。 */
const real = new Map();
for (const [cls, file] of builtins) {
  if (!existsSync(file)) {
    problems.push({
      key: cls,
      kind: '内置 provider 的源文件找不到',
      expected: '-',
      actual: '-',
      src: file,
    });
    continue;
  }
  const sf = parse(file);
  const name = classProp(sf, 'name');
  const caps = classProp(sf, 'capabilities');
  if (typeof name !== 'string' || caps === undefined || typeof caps !== 'object') {
    problems.push({
      key: cls,
      kind: '读不出真 provider 的 name / capabilities 声明',
      expected: '(读不出)',
      actual: '-',
      src: file,
    });
    continue;
  }
  real.set(name, { caps, file });
}

// ── 第二步：替身注册表里那几个**同名**替身的 caps ────────────────────────────
function fakeRegistryProviders() {
  const sf = parse(FAKES);
  const env = topLevelConsts(sf);

  // `FakeProvider` 构造函数第 2 参的**默认值**（今天是 `CAPS`）—— 一参调用取它。
  let defaultCaps;
  let paramIndex = -1;
  const findCtor = (n) => {
    if (ts.isClassDeclaration(n) && n.name?.text === 'FakeProvider') {
      for (const m of n.members) {
        if (!ts.isConstructorDeclaration(m)) continue;
        m.parameters.forEach((p, i) => {
          if (ts.isIdentifier(p.name) && p.name.text === 'capabilities') {
            paramIndex = i;
            defaultCaps = evalNode(p.initializer, env);
          }
        });
      }
    }
    ts.forEachChild(n, findCtor);
  };
  ts.forEachChild(sf, findCtor);

  // `makeFakeRegistry` 函数体内的 `new FakeProvider(<name>, <caps?>)`。
  // ⚠️ 只在这个函数体里找：`makeNoHeadlessProvider` 里那个刻意降级的替身在函数体外，
  // 天然不在管辖内（见头注「刻意不管」1）。
  const rows = [];
  const findFn = (n) => {
    if (
      (ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) &&
      n.name &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'makeFakeRegistry'
    ) {
      const collect = (m) => {
        if (
          ts.isNewExpression(m) &&
          ts.isIdentifier(m.expression) &&
          m.expression.text === 'FakeProvider'
        ) {
          const args = m.arguments ?? [];
          const name = evalNode(args[0], env);
          const caps =
            args.length > paramIndex && paramIndex >= 0
              ? evalNode(args[paramIndex], env)
              : undefined;
          rows.push({ name, caps: caps ?? defaultCaps, explicit: caps !== undefined });
        }
        ts.forEachChild(m, collect);
      };
      ts.forEachChild(n, collect);
    }
    ts.forEachChild(n, findFn);
  };
  ts.forEachChild(sf, findFn);
  return rows;
}

const fakeRows = fakeRegistryProviders();
if (fakeRows.length === 0) {
  console.error(
    '✗ 从 _fakes.ts#makeFakeRegistry 里读不出任何 `new FakeProvider(...)` —— 结构变了？⛔ 不当作通过。',
  );
  process.exit(2);
}

// ── 第三步：按名字逐个配对，逐位比 ───────────────────────────────────────────
for (const [name, { caps, file }] of real) {
  const row = fakeRows.find((r) => r.name === name);
  if (row === undefined) {
    problems.push({
      key: name,
      kind: '替身注册表里没有这个内置 provider（e2e 从此照不到它）',
      expected: name,
      actual: '(缺席)',
      src: file,
    });
    continue;
  }
  if (row.caps === undefined || typeof row.caps !== 'object') {
    problems.push({
      key: name,
      kind: '读不出替身的 capabilities',
      expected: JSON.stringify(caps),
      actual: '(读不出)',
      src: FAKES,
    });
    continue;
  }
  const bits = [...new Set([...Object.keys(caps), ...Object.keys(row.caps)])].sort();
  for (const bit of bits) {
    checked.push(`${name}.${bit}`);
    const e = JSON.stringify(caps[bit]);
    const a = JSON.stringify(row.caps[bit]);
    if (e !== a) {
      problems.push({
        key: `${name}.${bit}`,
        kind:
          bit in caps
            ? bit in row.caps
              ? '替身与真 provider 的这一位不一致'
              : '替身少了这一位'
            : '替身多了一位真 provider 没有的',
        expected: e ?? '(无)',
        actual: a ?? '(无)',
        src: file,
      });
    }
  }
}
for (const row of fakeRows) {
  if (typeof row.name === 'string' && !real.has(row.name)) {
    problems.push({
      key: String(row.name),
      kind: '替身注册表里有个内置 provider 名单里没有的名字',
      expected: '(内置里没有)',
      actual: String(row.name),
      src: FAKES,
    });
  }
}

// ── 报告 ────────────────────────────────────────────────────────────────────
console.log(
  `api 替身能力位镜像检查：${String(real.size)} 个内置 provider × 能力位，共比对 ${String(checked.length)} 个值`,
);
console.log(
  `  真 provider 声明处: ${[...real.values()].map((r) => r.file.replace(API + '/', '')).join('\n                      ')}`,
);
console.log(`  替身: ${FAKES.replace(API + '/', '')}#makeFakeRegistry`);
if (problems.length === 0) {
  console.log('✓ 每个同名替身都逐位等于它冒充的那个真 provider。');
  process.exit(0);
}
console.log(`\n✗ ${String(problems.length)} 处对不上：\n`);
for (const p of problems) {
  console.log(`  · ${p.key} —— ${p.kind}`);
  console.log(`      真 provider 声明: ${p.expected}`);
  console.log(`      替身写的:         ${p.actual}`);
  console.log(`      权威来源:         ${p.src.replace(API + '/', '')}`);
}
console.log(
  '\n⚠️ 替身的值以真 provider 的 `readonly capabilities` 为准。⛔ 不要反过来改真 provider 迁就替身。',
);
console.log(
  '⚠️ 若两个内置 provider 真的分了家，修法是给替身分成两份 caps，⛔ 不是把它们改回一致。',
);
process.exit(1);
