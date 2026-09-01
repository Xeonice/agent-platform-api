import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

/**
 * Flat ESLint config. Harness pillars enforced here (docs/backend/01 §3, shared/09 §2.2):
 *   1. eslint-plugin-boundaries — DDD four-layer dependency rules (error level).
 *   2. no-restricted-syntax — bans new Date() / Date.now() / randomUUID()（成员调用与裸调
 *      两种写法都挡，Clock / IdGenerator ports, 25 §1.4），domain/application 另禁
 *      Math.random() / randomBytes()，AND `as unknown as` double casts
 *      (parity with the frontend repo; forces honest type narrowing).
 *   3. @typescript-eslint/no-restricted-imports — domain 的 import 白名单：三方库一律禁
 *      （boundaries 管不到 node_modules，见 DOMAIN_PURE_IMPORTS 的注释）。
 * 三者都是 `error`，CI 跑 --max-warnings=0，所以违例合不进来。
 */

// `x as unknown as Y` — banned everywhere, tests included (parity with frontend).
const NO_AS_UNKNOWN_AS = {
  selector:
    "TSAsExpression[expression.type='TSAsExpression'][expression.typeAnnotation.type='TSUnknownKeyword']",
  message: '禁止 as unknown as 双重断言 —— 用正当类型收窄替代（与前端仓库一致）。',
};

/**
 * e2e 里禁止手抄 app 的全局装配 —— 必须走 `configurePlatformApp()`。
 *
 * ⚠️ 这条不是风格洁癖，它挡的是一个**已经发生过**的失效：`main.ts` 装三样
 * （prefix / 管道 / `ErrorEnvelopeFilter`），而 20 个 e2e 里有 19 个各自手抄了前两样。
 * 少的那一样正是把错误响应归一成信封的那层，于是**每个 e2e 断言的错误形状都不是
 * 生产上会出现的形状**。`passcode.e2e-spec.ts` 里一直写着
 * `expect(locked.body.code).toBe('PASSCODE_LOCKED')`，实测：不装 filter ⇒ 5 passed，
 * 装上 ⇒ `expected 'BAD_REQUEST' to be 'PASSCODE_LOCKED'`。断言从头就在，
 * 是 app 少装一层让它失效的——用户因此在解锁页看到「Http Exception」而门禁全绿。
 *
 * 手抄意味着 20 次可以漏的机会。共用函数让偏差没有落脚点，这条规则让**下一次手抄**
 * 在 lint 阶段就停下，而不是等某个真实用户看见一句机器话。
 */
const NO_HANDROLLED_APP_SETUP = ['setGlobalPrefix', 'useGlobalPipes', 'useGlobalFilters'].map(
  (m) => ({
    selector: `CallExpression[callee.property.name='${m}']`,
    message: `e2e 不要手抄 app 装配：用 configurePlatformApp(app)（bootstrap/configure-app.ts）。漏掉 ErrorEnvelopeFilter 会让错误信封断言测到一个生产上不存在的形状。`,
  }),
);

/**
 * `SANDBOX_DEFAULT_IMAGE` 只许在 `shared-kernel/domain/builtin-image.ts` 里读一次。
 *
 * ⚠️ 这条挡的是一个**已经发生过**的分裂：同一个 env 曾被三处各自读取，兜底值却是
 * 两个不同的值（`ghcr.io/agent-infra/sandbox:latest` vs `alpine:3.20`）。于是没配这个
 * env 时，开机日志说「把 SANDBOX_DEFAULT_IMAGE 指向平台预制镜像」，而向导对用户说
 * 「镜像 `alpine:3.20` 尚未注册，请先注册它」——**两条提示指向两个不同的下一步**，
 * 而用户看得见的那条是错的：他会去注册一张 alpine，那张镜像既没有 agent 也没有 tmux，
 * 注册完照样用不了。全量测试 883 条**一条都没红**，因为没有任何断言在比对这三处。
 *
 * 用 `builtinImageRef()`（`@platform/shared-kernel`）。
 */
const NO_SCATTERED_DEFAULT_IMAGE = {
  selector:
    "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='SANDBOX_DEFAULT_IMAGE']",
  message:
    '不要各自读 SANDBOX_DEFAULT_IMAGE —— 用 builtinImageRef()（@platform/shared-kernel）。三处各读一次曾经分裂出两个不同的兜底值，把用户指向了错误的下一步。',
};

// time bans — exempted only in port implementations and tests.
const NO_DIRECT_TIME = [
  {
    selector: "NewExpression[callee.name='Date']",
    message: 'Use the Clock port — new Date() is banned (01 §3 / 25 §1.4).',
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'Use the Clock port — Date.now() is banned (01 §3 / 25 §1.4).',
  },
];

/**
 * ID 生成禁令 —— **两种写法都要挡**。
 *
 * ⚠️ 这条以前只有一个选择器 `CallExpression[callee.property.name='randomUUID']`，
 * 它匹配的是**成员调用** `crypto.randomUUID()`。而
 * `import { randomUUID } from 'node:crypto'` 之后裸调 `randomUUID()` 是
 * `callee.name`、不是 `callee.property.name` —— 选择器压根匹配不到，一行 import
 * 就把整条禁令绕干净了。这不是假想：`apps/api/src/bootstrap/error-envelope.filter.ts`
 * 正是这么写的，在门禁全绿的情况下活到了今天（那一处的豁免与理由见文件底部）。
 *
 * 「看着有规则、实际匹配不到」比没有规则更糟：它让每个来 review 的人以为这里查过了。
 * 所以成员形式与裸调形式各留一条，缺一不可。
 */
const NO_RANDOM_ID = [
  {
    selector: "CallExpression[callee.property.name='randomUUID']",
    message: 'Use the IdGenerator port — crypto.randomUUID() is banned (01 §3).',
  },
  {
    selector: "CallExpression[callee.name='randomUUID']",
    message:
      'Use the IdGenerator port — 裸调 randomUUID() 同样禁止（换个 import 写法不算绕过，01 §3）。',
  },
];

// 全仓禁令的本体：时间 + 业务 ID。端口实现处豁免（见文件底部的 files 块）。
const NO_DIRECT_TIME_AND_ID = [...NO_DIRECT_TIME, ...NO_RANDOM_ID];

/**
 * domain / application 里另禁通用随机源：`Math.random()` 与 `randomBytes()`。
 *
 * 01 §3 给这条禁令的理由是「时间与 ID 是本项目最大的测试不确定性来源」。按这个理由，
 * 随机源本来就该在名单里 —— 而此前它们**一个都不在**：domain 里写
 * `Math.random()` 是全绿的。
 *
 * ★ 但射程只画到 domain / application，同样是按那句理由画的：它保护的是**业务逻辑
 * 能被写成确定性用例**。再往外一层，随机恰恰是正确答案而不是问题 ——
 *   · `credential/infrastructure/crypto/aes-gcm.crypto.ts` 的 AES IV
 *   · `shared-kernel/src/crypto/master-key.ts` 的主密钥
 *   · `terminal/interface/gateway/terminal.gateway.ts` 的 128-bit WS session key
 *   · `sandbox/infrastructure/providers/aio/*` 的容器内临时目录名
 * 这些要的是**密码学强度的不可预测**。把它们赶去走 `IdGenerator` 端口是把「给业务实体
 * 发 ID」的端口挪作他用，还会让下一个人误以为这些值是可复现的 —— 那是安全事故，不是洁癖。
 *
 * 所以边界画在**层**上，而不是逐处 `eslint-disable`：domain/application 里出现随机
 * 一定是坏味道，infrastructure/interface/platform 里出现随机是本分。层是结构性的判据，
 * 不需要每个新文件的作者重新判断一次。
 */
const NO_NONDETERMINISTIC_RANDOM = [
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message:
      'domain/application 禁止 Math.random() —— 随机会让业务用例不可复现；需要随机就把它推到 infrastructure（01 §3）。',
  },
  {
    selector: "CallExpression[callee.property.name='randomBytes']",
    message:
      'domain/application 禁止 randomBytes() —— 随机会让业务用例不可复现；密码学随机属于 infrastructure/interface（01 §3）。',
  },
  {
    selector: "CallExpression[callee.name='randomBytes']",
    message:
      'domain/application 禁止 randomBytes() —— 随机会让业务用例不可复现；密码学随机属于 infrastructure/interface（01 §3）。',
  },
];

/**
 * ① domain 的三方库禁令 —— 白名单制。
 *
 * ⚠️ 这条补的是一个**门禁根本不存在**的缺口。01 §3 写着 domain「明确禁止任何三方 IO 库
 * （provider SDK/drizzle/socket.io）」，而在此之前**没有任何一行配置在执行这句话**：
 * `boundaries` 只认仓内元素（domain/application/infrastructure/...），`node_modules`
 * 里的包压根不是元素，六条层间规则对它们一言不发。实测把 `dockerode`、`drizzle-orm`、
 * `socket.io`、`better-sqlite3` 逐个 import 进 domain 实体，`pnpm lint` 全绿。
 *
 * ★ 为什么是白名单而不是黑名单：黑名单只挡得住今天 package.json 里那几个名字，
 * 下一个被引进来的 SDK 照样通过 —— 而「下一个」正是这条规则要防的东西。domain 该依赖
 * 什么是**可枚举的**（自己人 + 纯计算），列白名单才是照着规约执行。
 *
 * ★ 豁免边界画在「这个 import 会不会带来 IO / 不确定性」，不画在「是不是三方包」：
 *   · `./ ../`                 —— 同上下文 domain 内部，boundaries 已管住层。
 *   · `@platform/shared-kernel` —— 唯一允许的仓内包（与 boundaries 的 domain 规则一致）。
 *     `@platform/contracts` 与别的 module 一律不放行。
 *   · `node:crypto`            —— **纯计算**，不碰 fd/socket/子进程。现役用法：
 *     `credential/domain/value-objects/masked-identifier.vo.ts` 的 `createHash`
 *     做 sha256。它是个纯函数，禁它没有任何道理。node:crypto 里唯一危险的那部分
 *     （randomUUID/randomBytes）由上面的 syntax 禁令单独挡，两条规则各管一段。
 *   · `node:stream`            —— **只许 `import type`**（`allowTypeImports`）。现役用法：
 *     `project/domain/ports/retained-volume-store.port.ts` 用 `Readable` 写端口签名，
 *     那是类型，编译后一行代码都不剩。运行时 `import { Readable }` 去构造流就是 IO 了，
 *     照红。这一条是「按 import type 划线」这个手法在本配置里的唯一一处，值得记住。
 *
 * 其余 node 内建（`node:fs` / `node:child_process` / `node:net` …）一律红：它们就是 IO 本身。
 *
 * 用 `regex` 而不是 gitignore 风格的 `group`：`group` 的否定项遵循 gitignore 的
 * 「父目录被排除就无法再放行子路径」规则，`'!@platform/shared-kernel'` 与 `'!../**'`
 * 实测都不生效（相对路径会被整片误伤）。下面这条正则读法很直白：
 * 「不以 `.` 开头（即包名 import），且不是这三项之一」。
 */
const DOMAIN_PURE_IMPORTS = {
  patterns: [
    {
      regex: '^(?!\\.)(?!@platform/shared-kernel(/|$))(?!node:crypto$)(?!node:stream$)',
      message:
        'domain 只能 import 相对路径 / @platform/shared-kernel / node:crypto / node:stream(type-only)。三方 IO 库（provider SDK、drizzle、socket.io、better-sqlite3…）与框架代码属于 infrastructure（01 §3）。',
    },
    {
      group: ['node:stream'],
      allowTypeImports: true,
      message:
        'domain 只能以 `import type` 形式引用 node:stream（用于端口签名）；运行时构造流是 IO，放 infrastructure（01 §3）。',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
      'drizzle/**',
      'coverage/**',
      // ⚠️ 运行期数据根（DATA_ROOT 默认 ./data）。CI 是干净检出、这个目录不存在，
      // 所以少了这一条 CI 照样绿；但**本机跑过后端之后**，里面是沙箱工作区和 git
      // 基线（别人的仓库源码），`pnpm lint` 会被几百个与本仓无关的错淹掉 —— 实测
      // 339 个。而「本地检查必须对齐 CI」是本仓反复强调的纪律，一个本地必红、CI 必
      // 绿的 lint 等于把这条纪律废掉：人会开始忽略 lint 的红。
      'data/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: { boundaries },
    settings: {
      'import/resolver': {
        typescript: {
          project: [
            'packages/shared-kernel/tsconfig.json',
            'packages/contracts/tsconfig.json',
            'packages/modules/project/tsconfig.json',
            'packages/modules/automation/tsconfig.json',
            'packages/modules/sandbox/tsconfig.json',
            'packages/modules/credential/tsconfig.json',
            'packages/modules/runtime/tsconfig.json',
            'packages/modules/image/tsconfig.json',
            'apps/api/tsconfig.json',
          ],
        },
        node: true,
      },
      // Each element captures its bounded-context module name (`module`) so the
      // rules below can forbid CROSS-CONTEXT internal imports, not just cross-LAYER
      // ones (P1-1). The composition-root module file is matched FIRST (order
      // matters) so it is NOT treated as `interface` — it is the one place a port
      // is wired to its impl.
      'boundaries/elements': [
        {
          type: 'module-root',
          mode: 'file',
          pattern: 'packages/modules/*/src/interface/*.module.ts',
          capture: ['module'],
        },
        { type: 'domain', pattern: 'packages/modules/*/src/domain/**', capture: ['module'] },
        {
          type: 'application',
          pattern: 'packages/modules/*/src/application/**',
          capture: ['module'],
        },
        {
          type: 'infrastructure',
          pattern: 'packages/modules/*/src/infrastructure/**',
          capture: ['module'],
        },
        { type: 'interface', pattern: 'packages/modules/*/src/interface/**', capture: ['module'] },
        { type: 'shared-kernel', pattern: 'packages/shared-kernel/**' },
        { type: 'contracts', pattern: 'packages/contracts/**' },
      ],
      'boundaries/ignore': ['**/*.spec.ts', '**/*.e2e-spec.ts', '**/test/**'],
    },
    rules: {
      // `{ module: '${from.module}' }` pins each intra-module layer allowance to the
      // SAME bounded context. Importing another module's domain/application/etc.
      // internal files matches an element of a DIFFERENT module → no rule allows it
      // → error. Cross-context collaboration must go through the module's public
      // `src/index.ts` (a non-element path, hence unrestricted) — i.e. `@platform/*`.
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            {
              from: 'module-root',
              allow: [
                ['domain', { module: '${from.module}' }],
                ['application', { module: '${from.module}' }],
                ['infrastructure', { module: '${from.module}' }],
                ['interface', { module: '${from.module}' }],
                'contracts',
                'shared-kernel',
              ],
            },
            { from: 'domain', allow: [['domain', { module: '${from.module}' }], 'shared-kernel'] },
            {
              from: 'application',
              allow: [
                ['domain', { module: '${from.module}' }],
                ['application', { module: '${from.module}' }],
                'contracts',
                'shared-kernel',
              ],
            },
            {
              from: 'infrastructure',
              allow: [
                ['domain', { module: '${from.module}' }],
                ['infrastructure', { module: '${from.module}' }],
                'contracts',
                'shared-kernel',
              ],
            },
            {
              from: 'interface',
              allow: [
                ['application', { module: '${from.module}' }],
                ['interface', { module: '${from.module}' }],
                'contracts',
              ],
            },
            // contracts may lean on the shared kernel (pure primitives / catalogs like
            // the git-platform registry). shared-kernel never imports contracts, so this
            // introduces no cycle.
            { from: 'contracts', allow: ['contracts', 'shared-kernel'] },
            { from: 'shared-kernel', allow: ['shared-kernel'] },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...NO_DIRECT_TIME_AND_ID,
        NO_AS_UNKNOWN_AS,
        NO_SCATTERED_DEFAULT_IMAGE,
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // ── ① domain 的 import 白名单（见 DOMAIN_PURE_IMPORTS 的注释）───────────────
  // 只作用于 `packages/modules/*/src/domain/**`。shared-kernel 不在其内：它自己就是
  // domain 允许依赖的那一格，且 `src/crypto`、`src/fs` 明摆着是给别人用的 IO 工具。
  {
    files: ['packages/modules/*/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off', // 基础规则不认 allowTypeImports，统一用 TS 版
      '@typescript-eslint/no-restricted-imports': ['error', DOMAIN_PURE_IMPORTS],
    },
  },
  // ── ③ domain / application 另禁通用随机源（见 NO_NONDETERMINISTIC_RANDOM 的注释）──
  // `shared-kernel/src/domain` 一并纳入 —— 它是 domain 允许依赖的那一格，同一条理由。
  {
    files: [
      'packages/modules/*/src/domain/**/*.ts',
      'packages/modules/*/src/application/**/*.ts',
      'packages/shared-kernel/src/domain/**/*.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...NO_DIRECT_TIME_AND_ID,
        ...NO_NONDETERMINISTIC_RANDOM,
        NO_AS_UNKNOWN_AS,
        NO_SCATTERED_DEFAULT_IMAGE,
      ],
    },
  },
  // Port implementations are the ONLY sanctioned place for time/random (01 §3 exemption).
  // `as unknown as` stays banned even here.
  //
  // `shared-kernel/src/ports/time.util.ts` joins them for a DIFFERENT reason, spelled
  // out at `fromEpochMs`: it never reads a clock, it converts an ABSOLUTE timestamp
  // handed to us by a third party (the in-sandbox agent reports file mtimes as epoch
  // seconds). The ban exists to keep "now" behind the Clock port so tests can pin it;
  // a pure `epoch → Date` function is outside what that ban is protecting.
  {
    files: [
      'apps/api/src/platform/time/**/*.ts',
      'apps/api/src/platform/access-passcode/**/*.ts',
      'packages/shared-kernel/src/ports/time.util.ts',
    ],
    rules: { 'no-restricted-syntax': ['error', NO_AS_UNKNOWN_AS] },
  },
  // 唯一允许读 SANDBOX_DEFAULT_IMAGE 的地方 —— 它就是那个「一次」（见规则注释）。
  {
    files: ['packages/shared-kernel/src/domain/builtin-image.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...NO_DIRECT_TIME_AND_ID,
        ...NO_NONDETERMINISTIC_RANDOM,
        NO_AS_UNKNOWN_AS,
      ],
    },
  },
  /**
   * `error-envelope.filter.ts` 的 `randomUUID()` —— 唯一一处 ID 禁令豁免，而它正是
   * 缺口 ② 的**现场**：这个文件用 `import { randomUUID } from 'node:crypto'` + 裸调，
   * 于是旧选择器（只匹配 `crypto.randomUUID()` 成员调用）从来没看见过它。禁令修好之后
   * 它会立刻变红，所以必须在这里表态，而不是默默放过。
   *
   * 判它豁免而不是改代码，理由有三，缺一不可：
   *   ① 它生成的 `traceId` 是**可观测性关联 ID**，不是业务实体 ID。`IdGenerator` 端口
   *      的存在意义是「让实体 ID 在测试里可钉」，而 traceId 恰恰要求每个响应都不一样，
   *      没有任何断言在钉它（`error-envelope.filter.spec.ts` 只断言它存在）。
   *   ② 这个 filter 由 `configure-app.ts` 手工 `new ErrorEnvelopeFilter()` 装上，
   *      **不走 DI** —— 为了拿一个 traceId 给它开一条注入通道，是让门禁反过来改架构。
   *   ③ 它在 bootstrap 层（组装根），与已豁免的 `platform/time/**` 同一档。
   * 豁免只画到这一个文件，不是整个 `bootstrap/`：下一个在 bootstrap 里发 ID 的人仍要红。
   */
  {
    files: ['apps/api/src/bootstrap/error-envelope.filter.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...NO_DIRECT_TIME,
        NO_AS_UNKNOWN_AS,
        NO_SCATTERED_DEFAULT_IMAGE,
      ],
    },
  },
  // Tests may use wall-clock time and cross layers freely — but NOT `as unknown as`.
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', '**/test/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', NO_AS_UNKNOWN_AS],
      'boundaries/element-types': 'off',
      '@typescript-eslint/no-restricted-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  // e2e 另加一条：app 装配必须走共用函数（见 NO_HANDROLLED_APP_SETUP 的注释）。
  {
    files: ['apps/api/test/e2e/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', NO_AS_UNKNOWN_AS, ...NO_HANDROLLED_APP_SETUP],
    },
  },
);
