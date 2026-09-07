#!/usr/bin/env node
/**
 * `SANDBOX_DEFAULT_IMAGE` 的三个出处必须说同一句话。
 *
 * ── 它修的是什么：一个变量、三处默认值、两两不同 ──────────────────────────────
 * 2026-09-07 实测到的状态：
 *
 *   docker-compose.yml   ghcr.io/agent-infra/sandbox:latest      ← 上游基础镜像
 *   .env.example         localhost:5001/platform/sandbox:v2      ← 开发者的本地坐标
 *   代码兜底              alpine:3.20                             ← 故意必炸
 *
 * 三条部署入口给出三个不同的答案，而**没有一个是对的**：compose 那条不报错就起来了，
 * 但预制镜像没装 claude-code —— 每个 claude-code Task 现装 753 秒，永远。
 *
 * ⚠️ `builtin-image.ts` 顶部那段注释记着这个病的**上一次发作**：「同一个
 * `SANDBOX_DEFAULT_IMAGE` 曾被三处各自读取，兜底值却是两个不同的值」。那一轮把**代码里**
 * 的三处收成了一处，而**部署配置这一层的分叉没人管** —— 于是它在另一层复发了。
 *
 * ⛔ 代码兜底（`alpine:3.20`）**不参与本检查**：它的作用正是「让『没配』被看见」，
 * 与前两者是不同性质的值。检查的是**两条真实部署入口**是否一致。
 *
 * ── ④ 出厂坐标必须真的有人发布（2026-09-07 补）────────────────────────────────
 * ⚠️ 这条修的是**本次改动自己引入的同款风险**。原病灶是 `.env.example` 指向
 * `localhost:5001/platform/sandbox:v2` —— 一张**从没被任何 CI 推送过**的镜像。修法是
 * 改成 `ghcr.io/<owner>/agent-platform-*`，但那张也得真有 workflow 去推它才行；
 * **改了表忘了改 workflow（或反过来），出厂默认就又指向了一张不存在的镜像** —— 一模一样
 * 的病，只是坐标换了个样子。
 *
 * ⇒ 把「表里写的」与「workflow 真推的」焊死在一起。⛔ 解析不出矩阵时**判失败而不是跳过**：
 * 一个悄悄不检查的检查，正是当年让 `localhost:5001` 活到出厂的那种东西。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const compose = /SANDBOX_DEFAULT_IMAGE:\s*\$\{SANDBOX_DEFAULT_IMAGE:-([^}]*)\}/.exec(
  read('docker-compose.yml'),
)?.[1];
const envExample = /^SANDBOX_DEFAULT_IMAGE=(.*)$/m.exec(read('.env.example'))?.[1];

const problems = [];
if (compose === undefined)
  problems.push('docker-compose.yml 里读不到 SANDBOX_DEFAULT_IMAGE 那一行');
if (envExample === undefined) problems.push('.env.example 里读不到 SANDBOX_DEFAULT_IMAGE 那一行');

// ── ① 两条部署入口必须说同一句话 ──────────────────────────────────────────
if (compose !== undefined && envExample !== undefined && compose.trim() !== envExample.trim()) {
  problems.push(
    `两条部署入口的默认镜像不一致：\n` +
      `    docker-compose.yml : ${compose.trim() || '（空）'}\n` +
      `    .env.example       : ${envExample.trim() || '（空）'}\n` +
      `  ⇒ 同一个变量的两个真相源。用户走哪条入口决定他拿到哪张镜像，而这件事没人告诉他。`,
  );
}

// ── ② 出厂**必须留空** ────────────────────────────────────────────────────
// ⛔ 一填这里，`builtinImageRefFor` 的按档自动选就永远不生效（它判的正是「配了没有」）。
//    mac 上默认档是 boxlite，却会拿到填进去的那张 —— 拉得到、播得下去，
//    **在建任务门口才撞 IMAGE_PROVIDER_MISMATCH**。一个填错的"贴心默认"比留空更难查。
for (const [where, val] of [
  ['docker-compose.yml', compose],
  ['.env.example', envExample],
]) {
  if (val !== undefined && val.trim() !== '') {
    problems.push(
      `${where} 给 SANDBOX_DEFAULT_IMAGE 填了具体坐标 \`${val.trim()}\`。\n` +
        `  ⇒ 出厂必须**留空**：留空才会走「按机器选发布镜像」那条路\n` +
        `    （darwin ⇒ boxlite，linux ⇒ aio；两档镜像不可互换）。`,
    );
  }
}

// ── ③ 按档发布坐标必须都在血统白名单里 ────────────────────────────────────
// 只改坐标不改表，会把「找不到镜像」换成「拉到了但注册被拒」—— 更难懂。
const src = read('packages/shared-kernel/src/domain/builtin-image.ts');
const published = [...src.matchAll(/^\s*(aio|boxlite):\s*'([^']+)',/gm)].map((m) => [m[1], m[2]]);
if (published.length === 0)
  problems.push('读不到 PUBLISHED_IMAGE_BY_PROVIDER —— 按档发布坐标表不见了');

const repoPath = (ref) => {
  const noTag = ref.replace(/:[^/:]+$/, '');
  const i = noTag.indexOf('/');
  if (i === -1) return noTag;
  const first = noTag.slice(0, i);
  return first.includes('.') || first.includes(':') || first === 'localhost'
    ? noTag.slice(i + 1)
    : noTag;
};
const listed = [...src.matchAll(/^\s*'([^']+)',\s*$/gm)].map((m) => m[1]);
for (const [provider, ref] of published) {
  const path = repoPath(ref);
  if (!listed.some((r) => path === r || path.endsWith(`/${r}`))) {
    problems.push(
      `${provider} 档的发布坐标 ${ref}（仓库路径 ${path}）不在 KNOWN_TMUX_REPOSITORIES 里。\n` +
        `  ⇒ 平台会拉到它、然后在注册期血统检查上拒掉自己的出厂默认 ——\n` +
        `    那比「找不到镜像」更难懂。改发布坐标与改那张表**必须同时做**。`,
    );
  }
}

// ── ④ 出厂坐标必须真的是那条发布 workflow 会推出去的镜像 ──────────────────
// 「表里一份、workflow 里一份」是**两处各写一遍**，而这次改动的病根正是它。
const WF = '.github/workflows/publish-sandbox-image.yml';
const wf = read(WF);
// ⚠️ 依赖 include 条目的键序 tier → context → image。改了键序这里会**判失败**
//    （不是静默放过），照着报错改这条正则即可。
const matrix = [
  ...wf.matchAll(/-\s*tier:\s*(\S+)\s*\n\s*context:\s*(\S+)\s*\n\s*image:\s*(\S+)/g),
].map((m) => ({ tier: m[1], context: m[2], image: m[3] }));
// ⚠️ **按条目数对账，而不是「有解析出东西就算数」**：键序只改了一条时，正则会漏掉那条、
//    其余照常解析，于是报错会变成「矩阵里没有 tier: aio」—— 而 aio 明明在，只是键序变了。
//    **报错指错方向和不报错一样贵**，所以先把「没解析全」这件事单独说清楚。
const declaredTiers = [...wf.matchAll(/^\s*-?\s*tier:\s*\S+\s*$/gm)].length;
if (matrix.length !== declaredTiers) {
  problems.push(
    `${WF} 的发布矩阵解析不全：文件里有 ${declaredTiers} 条 tier，只解析出 ${matrix.length} 条。\n` +
      `  ⇒ include 条目必须按 tier → context → image 的键序写（这条正则依赖它）。\n` +
      `    改了键序就照着改本脚本 —— 解析不出就判失败，不静默跳过。`,
  );
}

const tagOf = (ref) => /:([^/:]+)$/.exec(ref)?.[1] ?? 'latest';
for (const [provider, ref] of published) {
  const entry = matrix.find((m) => m.tier === provider);
  if (entry === undefined) {
    problems.push(
      `${provider} 档的出厂坐标是 ${ref}，但 ${WF} 的矩阵里没有 tier: ${provider}。\n` +
        `  ⇒ **没有任何 CI 会推这张镜像** —— 新部署第一次启动就是「找不到镜像」，\n` +
        `    与这次要修的原始 bug（localhost:5001/platform/sandbox:v2）是同一个病。`,
    );
    continue;
  }
  // 表里写的仓库名要与 workflow 推的那个逐字相同（比对末段，registry/owner 由 workflow 拼）
  const repo = repoPath(ref).split('/').pop();
  if (repo !== entry.image) {
    problems.push(
      `${provider} 档：出厂坐标 ${ref} 的仓库名是 \`${repo}\`，\n` +
        `    而 ${WF} 推的是 \`${entry.image}\`。两处各写一遍，改一处就指向了一张没人发布的镜像。`,
    );
  }
  // 表里用哪个 tag，workflow 就得推哪个 tag
  const tag = tagOf(ref);
  if (!new RegExp(`\\$\\{\\{\\s*matrix\\.image\\s*\\}\\}:${tag}\\b`).test(wf)) {
    problems.push(
      `${provider} 档：出厂坐标用的是 \`:${tag}\`，但 ${WF} 的 tags 里没有推这个 tag。\n` +
        `  ⇒ 镜像推上去了，出厂默认那一行仍然 404。`,
    );
  }
  // ⛔ **坐标必须全小写** —— OCI 仓库名的硬约束，GHCR 也照办。本仓库 owner 是 `Xeonice`，
  //    照抄大小写会让 buildx 在推之前就拒：`repository name must be lowercase`。
  //    这条在本地就拦得住，不必等 CI 跑 40 分钟再说。
  const path = repoPath(ref);
  if (path !== path.toLowerCase()) {
    problems.push(
      `${provider} 档的出厂坐标 ${ref} 含大写字母。\n` +
        `  ⇒ OCI 仓库名必须全小写，buildx 会在推送前直接拒掉（repository name must be lowercase）。`,
    );
  }
  // 构建上下文得真的存在，否则失败发生在 CI 里而不是这里
  try {
    read(`${entry.context}/Dockerfile`);
  } catch {
    problems.push(
      `${provider} 档的构建上下文 ${entry.context}/Dockerfile 不存在 —— 那条 workflow 跑不起来。`,
    );
  }

  // ⛔ **镜像必须设 UTF-8 locale**（2026-09-07 真机 + 镜像内实测）。
  //    基础镜像里 `LC_CTYPE=POSIX`，而 agent 会话跑在 tmux 里；tmux 按客户端 locale
  //    决定要不要按 UTF-8 渲染，非 UTF-8 时把非 ASCII **逐个换成 `_`** ——
  //    Claude Code 的横幅 `▐▛███▜▌` 变成 `_______`，一眼像字体坏了。
  //    ⚠️ 平台侧的 `tmux -u` 修的是另一半；这一半（`ls`/`grep` 的多字节处理）只能在镜像里修。
  if (!/^ENV\s+LANG=C\.UTF-8\b/m.test(read(`${entry.context}/Dockerfile`))) {
    problems.push(
      `${entry.context}/Dockerfile 没有 \`ENV LANG=C.UTF-8\`。\n` +
        '  ⇒ 沙箱里 locale 会是 POSIX，tmux 会把 agent 界面里的非 ASCII 逐个换成 `_`。',
    );
  }
}
// 反向：workflow 推了一张没人当出厂默认用的镜像（不致命，但同样是两处不同步）
for (const m of matrix) {
  if (!published.some(([provider]) => provider === m.tier)) {
    problems.push(
      `${WF} 会推 ${m.tier} 档的 \`${m.image}\`，但 PUBLISHED_IMAGE_BY_PROVIDER 里没有这一档。\n` +
        `  ⇒ 白发一张没人用的镜像；要么补进表里，要么从矩阵里删掉。`,
    );
  }
}

if (problems.length > 0) {
  console.error('✗ SANDBOX_DEFAULT_IMAGE 一致性检查未通过：\n');
  for (const p of problems) console.error('  · ' + p + '\n');
  process.exit(1);
}
console.log(
  '✔ 出厂镜像坐标：两条部署入口都留空（按机器自动选），按档发布坐标全在血统白名单里，且都由发布 workflow 真推',
);
for (const [pv, rf] of published) {
  const e = matrix.find((m) => m.tier === pv);
  console.log(`    ${pv.padEnd(8)} → ${rf}  ⇐ ${e.context}`);
}
