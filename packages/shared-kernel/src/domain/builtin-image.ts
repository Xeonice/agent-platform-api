/**
 * 平台自带镜像的坐标 —— **全仓唯一来源**，也是**血统的锚点**（04 §7 ★血统 ③）。
 *
 * ⚠️ **它是「兜底那一张」，不是「唯一那一张」**（ADR 决策 C，2026-08-29 起）。
 * 两档的镜像已经分开了：aio 档是 `api/images/platform-sandbox`（上游 13GB + CLI），
 * boxlite 档是 `api/images/platform-boxlite`（`node:22-slim` + tmux + CLI，实测 1.25GB）
 * —— boxlite 背着 aio 镜像的代价是实测 190 秒冷启动，而那张镜像里的 HTTP 服务在
 * boxlite 档位下**一次都不会被调用**。
 *
 * ⇒ 按档取镜像用 `builtinImageRefFor(provider)`；本函数是它**没有按档覆盖时的兜底**。
 * ⚠️ **单档部署因此一样也不用多配**：只填 `SANDBOX_DEFAULT_IMAGE`，两档都指向它。
 *
 * ── 它修的是什么 ─────────────────────────────────────────────────────────────
 * 同一个 `SANDBOX_DEFAULT_IMAGE` 曾被三处各自读取，兜底值却是**两个不同的值**：
 *   `image-seeder.ts`              → `ghcr.io/agent-infra/sandbox:latest`
 *   `image-facade.adapter.ts`      → `alpine:3.20`
 *   `provision-sandbox.workflow.ts`→ `alpine:3.20`
 * 于是没配这个 env 时，开机日志说「把 SANDBOX_DEFAULT_IMAGE 指向平台预制镜像」，
 * 而向导对用户说「镜像 `alpine:3.20` 尚未注册，请先在镜像管理里注册它」——
 * **两条提示指向两个不同的下一步，其中一条是错的**，而错的那条正好是用户看得见的那条：
 * 他会去注册一张 alpine，而那张镜像既没有 agent 也没有 tmux，注册完照样用不了。
 *
 * ⚠️ 「说错下一步比不说更贵」：它把人送去做一件必然失败的事，还让他以为是自己做错了。
 *
 * ── 兜底为什么是上游镜像（一张**过不了**根镜像检查的镜像）────────────────────
 * 这是刻意的，与 `ImageSeeder` 的注释同源：`ghcr.io/agent-infra/sandbox` 是第三方镜像，
 * 不会打我们发明的 `platform.tmux`，所以没配 env 时播种会**响亮失败**并打出一条
 * 说得出下一步的日志。**兜底值的作用是让「没配」这件事被看见，不是让它悄悄能跑。**
 * `alpine:3.20` 两样都不占：它既没让「没配」被看见（它看起来像个正经镜像名），
 * 又把用户指向了错误的方向。
 */
export function builtinImageRef(): string {
  return process.env.SANDBOX_DEFAULT_IMAGE ?? 'ghcr.io/agent-infra/sandbox:latest';
}

/**
 * **按档**取预制镜像坐标 —— `SANDBOX_<PROVIDER>_IMAGE`，没配则回落到
 * `SANDBOX_DEFAULT_IMAGE`（ADR 决策 C「镜像 / 数据面 / 控制面三样都不必统一」）。
 *
 * ── 为什么是「覆盖」而不是「每档各配一个」 ──────────────────────────────────
 * ⚠️ **绝大多数部署是单机单档**，不该为了双档能力多配一样东西。做成「必填两个」会让
 * 今天所有正确的配置在升级后变成错误配置，而它们并没有变错——那种迁移的真实结局是
 * 有人把两个都填成同一个值，于是这层配置除了多一行什么也没带来。
 *
 * ⇒ 语义是**覆盖**：不配 = 两档共用 `SANDBOX_DEFAULT_IMAGE`（今天的行为，一字不差）；
 * 配了 = 那一档用自己的那张。
 *
 * ⚠️ **每一张配到的镜像都会成为一个血统锚点**（`ImageSeeder` 全部以 `builtin:true`
 * 播种），而血统的多锚点比对本身早就支持（`lineageVerdict` 取最长前缀）。真正因此长出来
 * 的新概念是「**这张用户镜像能在哪一档跑**」——见 `ImageFacade.resolveForTask` 的
 * provider 参数。
 *
 * ⚠️ provider 名到 env 名的映射是 `toUpperCase()`，不做别的规整：provider 名是注册表
 * 的键（`aio` / `boxlite`），本来就只有小写字母。带连字符的名字要用这条路时，
 * **先改这里并补一条用例**，别在调用处自己拼 env 名——那正是 `SANDBOX_DEFAULT_IMAGE`
 * 当年分裂出两个不同兜底值的走法。
 */
export function builtinImageRefFor(provider: string): string {
  const override = (process.env[`SANDBOX_${provider.toUpperCase()}_IMAGE`] ?? '').trim();
  return override !== '' ? override : builtinImageRef();
}

/**
 * 全部**血统锚点**坐标（去重）—— 播种要种的就是这些。
 *
 * ⚠️ **单档部署这里恒为 1 个元素**，与搬家前一模一样；只有真的配了按档覆盖才会变成 2 个。
 */
export function builtinImageRefs(providers: readonly string[]): string[] {
  return [...new Set(providers.map((p) => builtinImageRefFor(p)))];
}

/**
 * `SANDBOX_DEFAULT_IMAGE` **配了没有** —— 诊断第 ⑧ 项第 1 步问的就是这一位
 * （P21-5 §9A）。
 *
 * ⚠️ **它必须与 `builtinImageRef()` 住在一起，而不是让调用方自己读那个 env。**
 * 上面那段注释记的分裂就是「三处各读一次」造成的，eslint 里因此有一条
 * `NO_SCATTERED_DEFAULT_IMAGE` 规则把直接读 `process.env.SANDBOX_DEFAULT_IMAGE` 全部
 * 挡掉。诊断需要区分「配了」与「回落到兜底」——那是一个**关于同一个 env 的新问题**，
 * 答案的正确位置是这里，不是绕过规则。
 *
 * ⚠️ 空串算**没配**：`SANDBOX_DEFAULT_IMAGE=` 在 compose 文件里是很常见的写法，
 * 它表达的是「我没填」而不是「镜像坐标是空字符串」。
 */
export function isBuiltinImageConfigured(): boolean {
  return (process.env.SANDBOX_DEFAULT_IMAGE ?? '').trim() !== '';
}

/**
 * 根镜像**声明了 tmux 吗** —— 04 §7 ★血统「注册期拦不声明」那一问的**新落点**。
 *
 * ══ 2026-08：这句声明从镜像标签搬到了平台配置 ═══════════════════════════════════
 *
 * 它以前问的是「这张镜像有没有 `platform.tmux=true` 这个 LABEL」。答案本身没问题，
 * **取答案的地方**有问题：上游镜像不会打我们发明的标签，所以为了让检查过，平台必须
 * 造一层 `platform/base` —— `FROM 上游` + 三个 LABEL、**零字节新层**。代价是
 *
 *   pull 13GB → 打标签 → push 13GB → **必须自建 registry 存它** → registry 跑在
 *   Docker 里 → Docker 一停整条链断。
 *
 * ⚠️ **13GB 的搬运，换的是一句「我确认这张镜像有 tmux」。** 而这句话的作者从来就是
 * **运维方**，不是镜像作者——`image-application.service.ts` 的注释一直这么写着：
 * 「运维方对自己指定的那张镜像做的一次**声明**」。把声明刻进镜像里，等于要求运维方
 * 先成为镜像作者才能说一句话。
 *
 * ⇒ 声明回到它本来的位置：**与 `SANDBOX_DEFAULT_IMAGE` 并列的一条平台配置**。
 *
 * ── 它仍然拦的是什么、仍然拦不住什么 ────────────────────────────────────────
 * ⚠️ **拦的是「指错了镜像」，不是「谎报」。** `SANDBOX_DEFAULT_IMAGE=alpine:3.20` 时
 * 开机就响亮地拒绝，而不是等第一个 Task 起 tmux 会话时才炸。**防谎报永远是运行期那次
 * `command -v tmux`**（⇒ `IMAGE_CONTRACT_VIOLATION`），本条替代不了它——这一点在搬家
 * 前后一字未变。
 *
 * ── 两条路，顺序即优先级 ────────────────────────────────────────────────────
 * ① `SANDBOX_DEFAULT_IMAGE_TMUX` —— 运维方的显式声明，**最高优先级**，也是唯一能让
 *    一张平台不认识的镜像通过的办法（自己构建的、内网 mirror 的、改名的）。
 * ② 平台内置的已知镜像表 —— 平台**自己构建或自己验证过**的那几张。它存在的理由是：
 *    默认配置不该要求运维方为一张平台自己发布的镜像手写一句声明；那种「装完还得再答
 *    一道题」的配置，最后都会被人用 `=true` 一把关掉，于是①的信号也一起没了。
 *
 * ⚠️ **不认识 + 没声明 ⇒ `false`，而不是「宽容地放过」。** `true` 兜底会让这条规则
 * 变成一句永远不拒绝的注释——它就是这么被删掉的那种规则。
 *
 * ⚠️ 显式的 `SANDBOX_DEFAULT_IMAGE_TMUX=false` **压得过**内置表：运维方说「我知道这张
 * 镜像没 tmux」时，平台不该反过来告诉他有。
 */
export function builtinImageDeclaresTmux(ref: string = builtinImageRef()): boolean {
  const declared = (process.env.SANDBOX_DEFAULT_IMAGE_TMUX ?? '').trim().toLowerCase();
  if (declared !== '') return declared === 'true' || declared === '1';
  return isKnownTmuxImage(ref);
}

/**
 * 平台内置的**已知镜像**表 —— 只认仓库路径，**不认 tag/digest**。
 *
 * ⚠️ 为什么不带版本：这张表回答的是「这条产品线里有没有 tmux」，那是一个关于**产品线**
 * 的事实（上游 AIO Sandbox 从来自带 tmux 3.2a，实测 v1.11.0）；把它钉到某个 tag 上，
 * 每次升级默认镜像都要回来改一行代码，而那一行代码**说不出任何新东西**。
 *
 * ⚠️ 为什么用后缀匹配仓库名：同一张镜像会以多个坐标出现——`ghcr.io/agent-infra/sandbox`、
 * 内网 mirror `registry.corp/agent-infra/sandbox`、本地 `localhost:5001/platform/sandbox`。
 * 匹配的是 `<registry>/` 之后那一段，所以 mirror 不需要额外配置。
 *
 * ⚠️ **匹配必须落在 `/` 边界上**：裸的 `endsWith('platform/sandbox')` 会把
 * `evil.io/notplatform/sandbox` 也认成自己人。
 */
function isKnownTmuxImage(ref: string): boolean {
  const path = repositoryPathOf(ref);
  return KNOWN_TMUX_REPOSITORIES.some((repo) => path === repo || path.endsWith(`/${repo}`));
}

/**
 * 平台自己构建（`api/images/platform-sandbox`）或自己实测过的镜像仓库。
 *
 * · `agent-infra/sandbox` —— 上游 AIO Sandbox，实测自带 tmux 3.2a（v1.11.0，2026-08）
 * · `platform/sandbox`    —— **aio 档**预制镜像，`FROM` 上游，构建期有 `command -v tmux` 自证
 * · `platform/boxlite`    —— **boxlite 档**精简镜像（`FROM node:22-slim` + tmux + CLI），
 *                            同样在构建期自证（`api/images/platform-boxlite`）
 */
const KNOWN_TMUX_REPOSITORIES = [
  'agent-infra/sandbox',
  'platform/sandbox',
  'platform/boxlite',
] as const;

/**
 * 平台内置已知镜像仓库的**只读视图**，给错误消息用。
 *
 * ⚠️ 它存在的理由是「这条约束今天只存在于一张表里，没有任何地方提示」：实测踩过一次
 * （2026-08-29，真 Linux）—— 按 README 的构建目录名 build 成 `…/platform-sandbox:v1`
 * （**连字符**），而表里是 `platform/sandbox`（**斜杠**），于是开机播种被拒，用户看到的
 * 是「平台还没有可用的预制镜像作为血统基准」——一句**完全没提到名字**的话。
 */
export function knownTmuxRepositories(): readonly string[] {
  return KNOWN_TMUX_REPOSITORIES;
}

/**
 * 一句**把正确形态说出来**的提示，附在「这张镜像平台不认识」的错误后面。
 *
 * ⚠️ 特判「只差一个分隔符」：`platform-sandbox` ↔ `platform/sandbox` 不是一个假想的
 * 笔误，它是**照着仓库目录名做的必然动作**（`api/images/platform-sandbox` 是目录名，
 * 而 `docker build -t <name>` 里的 `<name>` 是仓库名）。两者相差一个字符、语义完全不同，
 * 而失败信息此前一个字都没提到名字 ⇒ 排查方向必然跑偏（去查 registry、去查 tmux）。
 *
 * ⚠️ 提示**不放宽任何规则**：连字符那张照样被拒。它只是让被拒这件事说得出下一步。
 */
export function explainKnownTmuxRepositories(ref: string): string {
  const path = repositoryPathOf(ref);
  const nearMiss = KNOWN_TMUX_REPOSITORIES.find((repo) => {
    const hyphenated = repo.replace(/\//g, '-');
    return path === hyphenated || path.endsWith(`/${hyphenated}`);
  });
  const list = `平台内置已知镜像仓库：${KNOWN_TMUX_REPOSITORIES.join('、')}（匹配 \`<registry>/\` 之后那一段）。`;
  if (nearMiss === undefined) return list;
  return (
    `⚠️ '${path}' 与已知的 '${nearMiss}' 只差一个分隔符：镜像仓库名用**斜杠**（${nearMiss}），` +
    `而 ${nearMiss.replace(/\//g, '-')} 是**构建目录名**（api/images/${nearMiss.replace(/\//g, '-')}）。` +
    `\`docker build -t <registry>/${nearMiss.replace(/\//g, '-')}:<tag>\` 建出来的坐标平台认不出，` +
    `改成 \`-t <registry>/${nearMiss}:<tag>\` 重新构建并 push。` +
    list
  );
}

/** 去掉 tag / digest，只留 `<host>/<path>` —— 与 `isKnownTmuxImage` 同一套切法。 */
function repositoryPathOf(ref: string): string {
  return ref.replace(/@sha256:[0-9a-f]+$/i, '').replace(/:[^:/]+$/, '');
}
