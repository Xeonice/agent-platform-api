import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  builtinImageDeclaresTmux,
  builtinImageRef,
  builtinImageRefFor,
  builtinImageRefs,
  explainKnownTmuxRepositories,
  isBuiltinImageConfigured,
  knownTmuxRepositories,
  publishedImageFor,
} from '../../src/domain/builtin-image';

/**
 * 04 §7 ★血统 ③ 的**新落点**：根镜像的 tmux 声明。
 *
 * 2026-08 它从「镜像上的 `platform.tmux` 标签」搬到了这里 —— 因为那个标签逼着平台维护
 * 一层 `FROM 上游 + 3 个 LABEL`、零字节新层的中间镜像，只为盖章，代价是 13GB 的
 * pull/push 与一个**必须自建的 registry**。
 *
 * ⚠️ 这个文件钉的是「什么算声明过」，不是「镜像里真有没有 tmux」—— 后者永远由运行期
 * 那次 `command -v tmux` 回答（⇒ `IMAGE_CONTRACT_VIOLATION`）。两个时刻，两个码。
 */
const REF = 'SANDBOX_DEFAULT_IMAGE';
const TMUX = 'SANDBOX_DEFAULT_IMAGE_TMUX';
/**
 * ⚠️ 按档覆盖也必须进隔离名单。它们**不在**改动前的这份名单里，而按档自动选正是被
 * 它们压过去的一层 —— 跑测试的那台机器（或 `.env`）里只要有一个 `SANDBOX_AIO_IMAGE`，
 * 「没配时应该拿到发布镜像」那几条就会拿到别的值：**门禁的红绿由环境决定，不由代码决定**。
 */
const TIER = ['SANDBOX_AIO_IMAGE', 'SANDBOX_BOXLITE_IMAGE'] as const;

let savedRef: string | undefined;
let savedTmux: string | undefined;
let savedTier: Record<string, string | undefined> = {};

beforeEach(() => {
  savedRef = process.env[REF];
  savedTmux = process.env[TMUX];
  savedTier = Object.fromEntries(TIER.map((k) => [k, process.env[k]]));
  delete process.env[TMUX];
  for (const k of TIER) delete process.env[k];
});
afterEach(() => {
  if (savedRef === undefined) delete process.env[REF];
  else process.env[REF] = savedRef;
  if (savedTmux === undefined) delete process.env[TMUX];
  else process.env[TMUX] = savedTmux;
  for (const k of TIER) {
    const v = savedTier[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('平台内置的已知镜像表', () => {
  it.each([
    'ghcr.io/agent-infra/sandbox:latest',
    'localhost:5001/platform/sandbox:v2',
    'registry.corp.internal:8443/platform/boxlite:v1',
    // digest 形式与不带 tag 的形式都要认得出仓库名
    'ghcr.io/agent-infra/sandbox@sha256:' + 'a'.repeat(64),
    'agent-infra/sandbox',
  ])('认得 %s', (ref) => {
    process.env[REF] = ref;
    expect(builtinImageDeclaresTmux()).toBe(true);
  });

  it.each(['alpine:3.20', 'docker.io/library/ubuntu:22.04', 'registry.example/team/sandbox:v1'])(
    '不认得 %s —— 「指错了镜像」正是这条规则要抓的',
    (ref) => {
      process.env[REF] = ref;
      expect(builtinImageDeclaresTmux()).toBe(false);
    },
  );

  it.each([
    'evil.io/notplatform/sandbox:v1',
    'evil.io/xagent-infra/sandbox:v1',
    'evil.io/myplatform/boxlite:v1',
  ])('⭐ 匹配落在 `/` 边界上：%s 不是自己人', (ref) => {
    // MUTATION: 把 `path === repo || path.endsWith(`/${repo}`)` 改成裸的
    // `path.endsWith(repo)` ⇒ 本条红。⚠️ 没有这一组，那个 ⚠️ 注释就是一句无人验证的
    // 断言，而它保护的是「任何人只要把仓库命名成 …notplatform/sandbox 就自动获得
    // 平台认可」——一条静默生效的信任旁路。
    process.env[REF] = ref;
    expect(builtinImageDeclaresTmux()).toBe(false);
  });
});

describe('运维方的显式声明压过内置表（两个方向都要压得住）', () => {
  it.each(['true', 'TRUE', ' true ', '1'])('%s ⇒ 一张平台不认识的镜像也算声明过', (v) => {
    process.env[REF] = 'alpine:3.20';
    process.env[TMUX] = v;
    expect(builtinImageDeclaresTmux()).toBe(true);
  });

  it('false ⇒ 即使在内置表里也算没声明 —— 运维方说没有，平台不该反过来说有', () => {
    process.env[REF] = 'ghcr.io/agent-infra/sandbox:latest';
    process.env[TMUX] = 'false';
    expect(builtinImageDeclaresTmux()).toBe(false);
  });

  it('⚠️ 空串算「没填」，回落到内置表 —— compose 里 `X=` 是很常见的写法', () => {
    process.env[REF] = 'alpine:3.20';
    process.env[TMUX] = '   ';
    expect(builtinImageDeclaresTmux()).toBe(false);
    process.env[REF] = 'ghcr.io/agent-infra/sandbox:latest';
    expect(builtinImageDeclaresTmux()).toBe(true);
  });

  it('一个说不清的值不算 true —— 「yes」不是 true，别猜运维方的意思', () => {
    process.env[REF] = 'alpine:3.20';
    process.env[TMUX] = 'yes';
    expect(builtinImageDeclaresTmux()).toBe(false);
  });
});

describe('兜底坐标与「配了没有」（既有行为，别在搬家时弄丢）', () => {
  it('没配时回落到一张**过不了**根镜像检查的镜像不是运气，是设计', () => {
    delete process.env[REF];
    // 兜底值必须让「没配」这件事**被看见**。⚠️ 但它也在已知表里（上游确实有 tmux），
    // 所以今天挡住「没配」的是 `isBuiltinImageConfigured()` 那一位，不是 tmux 声明。
    expect(builtinImageRef()).toBe('ghcr.io/agent-infra/sandbox:latest');
    expect(isBuiltinImageConfigured()).toBe(false);
  });

  it('空串算没配', () => {
    process.env[REF] = '   ';
    expect(isBuiltinImageConfigured()).toBe(false);
  });
});

/**
 * 「这条约束今天只存在于一张表里，没有任何地方提示」—— 2026-08-29 真机踩到：按仓库里的
 * **构建目录名** build 成 `…/platform-sandbox:v1`（连字符），而表里是 `platform/sandbox`
 * （斜杠），于是开机播种被拒、自定义镜像注册报「平台还没有可用的预制镜像作为血统基准」
 * —— 一句**完全没提到名字**的话，排查方向必然跑偏。
 */
describe('错误信息自己说得出正确的镜像名形态', () => {
  it('⭐ 连字符写法被点名，并给出斜杠那一份', () => {
    // MUTATION: 删掉 nearMiss 那段、只留仓库清单 ⇒ 本条红。清单本身**说不出**
    // 「你现在写的这个名字差在哪」——而差的就是一个字符。
    const hint = explainKnownTmuxRepositories('localhost:5001/platform-sandbox:v1');
    expect(hint).toContain('platform/sandbox');
    expect(hint).toContain('platform-sandbox');
    expect(hint).toContain('api/images/platform-sandbox');
  });

  it.each([
    ['localhost:5001/platform-boxlite:v1', 'platform/boxlite'],
    ['platform-sandbox', 'platform/sandbox'],
    ['registry.corp/agent-infra-sandbox:v3', 'agent-infra/sandbox'],
  ])('%s ⇒ 点名 %s', (ref, want) => {
    const hint = explainKnownTmuxRepositories(ref);
    // ⚠️ 光断言「消息里出现了 platform/boxlite」是**假绿**：仓库清单本来就把三张都列了。
    // 必须钉住「它认出这是一次近似写法」，那才是 nearMiss 分支干的活。
    expect(hint).toContain('只差一个分隔符');
    expect(hint).toContain(`与已知的 '${want}' 只差一个分隔符`);
  });

  it('不是近似写法时只给清单，不硬凑一个「你大概是想写 X」', () => {
    // ⚠️ 乱猜比不猜贵：把 `alpine:3.20` 说成「你大概是想写 platform/sandbox」会让人
    // 去改一个他根本没打算用的名字。
    const hint = explainKnownTmuxRepositories('alpine:3.20');
    expect(hint).not.toContain('只差一个分隔符');
    for (const repo of knownTmuxRepositories()) expect(hint).toContain(repo);
  });

  it('清单与判定表是同一份 —— 不允许两处各写一遍', () => {
    // MUTATION: 在 `explainKnownTmuxRepositories` 里手写一份仓库清单 ⇒ 加一张新的
    // 已知镜像时两处会漂移，而漂移的症状是「提示里没有它」。
    for (const repo of knownTmuxRepositories()) {
      process.env[REF] = `registry.example/${repo}:v1`;
      expect(builtinImageDeclaresTmux()).toBe(true);
    }
  });
});

describe('平台 CI 发布的那一张镜像（2026-09-07，P21-8 §2.2）', () => {
  it('⛔ 出厂默认坐标必须过血统检查 —— 漏进已知表就会「拉到了但注册被拒」', () => {
    // 这条与 `.env.example` 的出厂值是**一对**：改一处不改另一处，新部署会撞上一个
    // 比「找不到镜像」更难懂的失败。
    expect(builtinImageDeclaresTmux('ghcr.io/xeonice/agent-platform-sandbox:latest')).toBe(true);
  });

  it('自建坐标仍然认得（本地开发那条路没被这次改动动到）', () => {
    expect(builtinImageDeclaresTmux('localhost:5001/platform/sandbox:v2')).toBe(true);
  });

  it('⛔ 冒充的仓库名认不出 —— 匹配必须落在 `/` 边界上', () => {
    expect(builtinImageDeclaresTmux('evil.io/notagent-platform-sandbox:v1')).toBe(false);
    expect(builtinImageDeclaresTmux('evil.io/agent-platform-sandbox-fake:v1')).toBe(false);
  });

  it('内网 mirror 形态照样认得（后缀匹配的用意）', () => {
    expect(builtinImageDeclaresTmux('registry.corp/mirror/agent-platform-sandbox:v1')).toBe(true);
  });

  it('⛔ 上游基础镜像**不是**可直接用的预制镜像这件事，不归这张表管', () => {
    // ⚠️ `agent-infra/sandbox` 在表里（它确实自带 tmux），但它没装 claude-code。
    //    「有没有 tmux」与「能不能当预制镜像用」是两个问题 —— 后者由 §2.2 的出厂配置
    //    与注册期的其余检查回答，别指望这张表拦住它。
    expect(builtinImageDeclaresTmux('ghcr.io/agent-infra/sandbox:latest')).toBe(true);
  });
});

/**
 * ── 按机器自动选那一张（2026-09-07，P21-8 §2.2）─────────────────────────────
 *
 * 用户初始化部署时**什么都没配**，平台也得拿得出一张能用的镜像；而「能用」是**按档**
 * 的：`hostPreferredProvider()` = darwin ? boxlite : aio，两档的镜像不可互换。
 *
 * ⚠️ 这一组钉的是**优先级**，不是某个字面量：显式配置 > 按档自动选 > 共用兜底。
 * 顺序反了不会有任何人报错 —— 平台会安静地把运维方配的那张换成自己挑的那张。
 */
describe('没配任何东西时，平台按档挑对那一张', () => {
  it('⭐ 两档各拿各的 —— **两张必须不同**，这是这条改动存在的全部理由', () => {
    // ⛔ 不写成「aio === 某字面量」：那种断言在两档被写成同一个值时照样绿，
    //    而两档相同正是 `IMAGE_PROVIDER_MISMATCH` 的来源。
    const aio = builtinImageRefFor('aio');
    const boxlite = builtinImageRefFor('boxlite');
    expect(aio).not.toBe(boxlite);
    expect(aio).toBe(publishedImageFor('aio'));
    expect(boxlite).toBe(publishedImageFor('boxlite'));
  });

  it('⛔ 自动挑出来的每一张都必须过血统检查 —— 否则「找不到镜像」变成「拉到了但注册被拒」', () => {
    // 这条把两张表焊在一起：`PUBLISHED_IMAGE_BY_PROVIDER` 加一档而
    // `KNOWN_TMUX_REPOSITORIES` 忘了跟，开机播种会被平台自己拒掉。
    for (const provider of ['aio', 'boxlite']) {
      expect(builtinImageDeclaresTmux(builtinImageRefFor(provider))).toBe(true);
    }
  });

  it('⛔ 自动挑的不是那张上游基础镜像 —— 它拉得到、过得了血统检查，但没装 claude-code', () => {
    // ⚠️ 实测：现装 claude-code 要 753 秒，落在**每一个** claude-code Task 上。
    //    这比「第一次启动报找不到」更糟：它不报错，只是慢。
    for (const provider of ['aio', 'boxlite']) {
      expect(builtinImageRefFor(provider)).not.toBe('ghcr.io/agent-infra/sandbox:latest');
    }
  });

  it('第三方 provider 不在表里 ⇒ 回落到共用兜底，与改动前一字不差', () => {
    // ⚠️ 平台不知道一个外部 provider 该用哪张镜像。**猜一个比让它响亮失败更糟**。
    expect(builtinImageRefFor('acme-vm')).toBe(builtinImageRef());
  });
});

describe('运维方配了什么，就用什么（自动选只在「他没说话」时开口）', () => {
  it('⭐ 显式 `SANDBOX_DEFAULT_IMAGE` 压得过按档自动选 —— 两档都听他的', () => {
    process.env[REF] = 'registry.corp/mirror/platform/sandbox:v9';
    expect(builtinImageRefFor('aio')).toBe('registry.corp/mirror/platform/sandbox:v9');
    expect(builtinImageRefFor('boxlite')).toBe('registry.corp/mirror/platform/sandbox:v9');
  });

  it('按档覆盖压得过一切，且只影响它自己那一档', () => {
    process.env.SANDBOX_BOXLITE_IMAGE = 'localhost:5001/platform/boxlite:v3';
    expect(builtinImageRefFor('boxlite')).toBe('localhost:5001/platform/boxlite:v3');
    // aio 那档没被动到，仍然走自动选
    expect(builtinImageRefFor('aio')).toBe(publishedImageFor('aio'));
  });

  it('⚠️ 空串算「没填」，照样回到自动选 —— compose 里 `X=` 是很常见的写法', () => {
    process.env[REF] = '';
    process.env.SANDBOX_AIO_IMAGE = '   ';
    expect(builtinImageRefFor('aio')).toBe(publishedImageFor('aio'));
  });
});

describe('播种要种几张（`builtinImageRefs` 的去重语义变了）', () => {
  it('⭐ 什么都不配 ⇒ 2 张（此前恒为 1 张）', () => {
    expect(builtinImageRefs(['aio', 'boxlite'])).toHaveLength(2);
  });

  it('显式配了共用坐标 ⇒ 回到 1 张，运维方说共用就共用', () => {
    process.env[REF] = 'registry.corp/platform/sandbox:v9';
    expect(builtinImageRefs(['aio', 'boxlite'])).toEqual(['registry.corp/platform/sandbox:v9']);
  });
});
