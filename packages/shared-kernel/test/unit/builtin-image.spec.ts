import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  builtinImageDeclaresTmux,
  builtinImageRef,
  explainKnownTmuxRepositories,
  isBuiltinImageConfigured,
  knownTmuxRepositories,
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

let savedRef: string | undefined;
let savedTmux: string | undefined;

beforeEach(() => {
  savedRef = process.env[REF];
  savedTmux = process.env[TMUX];
  delete process.env[TMUX];
});
afterEach(() => {
  if (savedRef === undefined) delete process.env[REF];
  else process.env[REF] = savedRef;
  if (savedTmux === undefined) delete process.env[TMUX];
  else process.env[TMUX] = savedTmux;
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
