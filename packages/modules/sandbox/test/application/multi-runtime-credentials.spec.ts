// 一个沙箱里同时备齐**多份** runtime 凭证（03 §4.3 ④ / 06 §5.6）。
//
// ── 为什么非这么做不可（物理限制，不是偏好）────────────────────────────────────
// 用户要能在终端里随手开 Codex / Claude Code / 纯终端。CLI 本来就预装在镜像里，
// 真正的拦路虎是**凭证**：env 形态的凭证（claude 的 `CLAUDE_CODE_OAUTH_TOKEN`、api-key）
// **只能在建实例时给** —— 按调用传 `env` 会在沙箱里被 `ps` 看见（04 §2.3★ 第 2 条），
// 而已经起来的进程加不了 env。⇒「点了 claude 标签再注入 claude 凭证」走不通，
// 只能在建实例前把所有已配置的一次性备齐。
//
// 代价（用户已裁决接受）：一个 Codex 任务的沙箱里也会躺着 Claude 的令牌。
// ⇒ 所以**注入了哪几份必须落审计**，这组用例把那条也钉住。
import { describe, it, expect } from 'vitest';
import type { InjectableRuntimeCredential } from '@platform/contracts';
import { FakeAdapter, harness, waitForStatus } from './_harness';

/** 一份带 env 的凭证替身（env 形态才是"只能建实例时给"的那一类）。 */
function credWithEnv(env: Record<string, string>): InjectableRuntimeCredential {
  return {
    runtimeId: 'stub',
    obtainedVia: 'setup-token',
    issuedAt: '2026-09-11T00:00:00.000Z',
    credentialFiles: [],
    env,
    zeroize(): void {},
  };
}

function twoRuntimes(): FakeAdapter[] {
  return [new FakeAdapter('claude-code', 'Claude Code', []), new FakeAdapter('codex', 'Codex', [])];
}

describe('provision ④ —— 把已配置的凭证**全部**注入', () => {
  it('⭐ 镜像声明支持两个 runtime、两个都配了凭证 ⇒ 两份都注入，两份都落账', async () => {
    const h = harness({
      adapters: twoRuntimes(),
      supportedRuntimes: ['claude-code', 'codex'],
      credentialsByRuntime: {
        'claude-code': credWithEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'c' }),
        codex: credWithEnv({ OPENAI_API_KEY: 'o' }),
      },
    });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');

    const after = await h.service.get(dto.id);
    // 「这个沙箱能跑哪几个」—— 终端下拉与 `POST .../:rt/tasks` 都读它。
    expect([...after.availableRuntimes].sort()).toEqual(['claude-code', 'codex']);
    // 两份都真的落进了 credential 上下文的台账。
    expect(h.injections.sort()).toEqual([`claude-code:${dto.id}`, `codex:${dto.id}`]);
  });

  it('⭐ 只配了一个 ⇒ 只注入那一个；另一个**不进**可用列表（下拉里不许出现）', async () => {
    const h = harness({
      adapters: twoRuntimes(),
      supportedRuntimes: ['claude-code', 'codex'],
      credentialsByRuntime: {
        'claude-code': credWithEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'c' }),
        codex: null, // 明确没配
      },
    });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');

    const after = await h.service.get(dto.id);
    expect(after.availableRuntimes).toEqual(['claude-code']);
    expect(h.injections).toEqual([`claude-code:${dto.id}`]);
  });

  it('⛔ 候选集是**镜像声明支持的**那些，不是注册表全集', async () => {
    // 往一个没装 claude CLI 的镜像里注入 claude 凭证，只会让下拉里多出一个
    // 点开就失败的选项。`supportedRuntimes` 就是镜像对"我预装了什么"的声明。
    const h = harness({
      adapters: twoRuntimes(),
      supportedRuntimes: ['codex'], // 镜像只说自己有 codex
      credentialsByRuntime: {
        codex: credWithEnv({ OPENAI_API_KEY: 'o' }),
        'claude-code': credWithEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'c' }),
      },
    });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'codex' });
    await waitForStatus(h.service, dto.id, 'running');

    expect((await h.service.get(dto.id)).availableRuntimes).toEqual(['codex']);
    expect(h.injections).toEqual([`codex:${dto.id}`]);
  });

  it('⚠️ 镜像没声明 supportedRuntimes ⇒ 退回只试默认那一个（与本切片之前一致）', async () => {
    const h = harness({
      adapters: twoRuntimes(),
      credentialsByRuntime: {
        'claude-code': credWithEnv({ X: '1' }),
        codex: credWithEnv({ Y: '2' }),
      },
    });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    expect((await h.service.get(dto.id)).availableRuntimes).toEqual(['claude-code']);
  });

  it('⭐ 一个凭证都没配 ⇒ **默认 runtime 仍然可用**（agent 照旧未登录起来）', async () => {
    // ⛔ 这一条挡住"只看注入列表"那种收紧：没配凭证的用户此前一直能建任务，
    //    agent 以未登录状态跑（provision 为此记了 `sandbox.credential.absent`）。
    //    把可用集缩成空会让那条一直存在的路直接消失。
    const h = harness({ adapters: twoRuntimes(), supportedRuntimes: ['claude-code', 'codex'] });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');

    const after = await h.service.get(dto.id);
    expect(after.availableRuntimes).toEqual(['claude-code']); // 默认那个永远在
    expect(h.injections).toEqual([]);
  });
});

describe('provision ④ —— env 撞车是平台配置错误，⛔ 不许静默覆盖', () => {
  it('⭐ 两个 runtime 用同一个 env 名注入 ⇒ **当场失败**，沙箱落 failed', async () => {
    // 既有纪律「凭证永远赢，靠顺序而非黑名单」（05 §4.1）说的是**凭证 vs 用户变量**，
    // 那里"谁赢"有明确答案。**凭证 vs 凭证**没有：按注册顺序谁在后面谁赢毫无依据，
    // 而后果是沉默的 —— 那个 CLI 不报错，只是拿着另一家的令牌跑。
    const h = harness({
      adapters: twoRuntimes(),
      supportedRuntimes: ['claude-code', 'codex'],
      credentialsByRuntime: {
        'claude-code': credWithEnv({ SHARED_TOKEN: 'c' }),
        codex: credWithEnv({ SHARED_TOKEN: 'o' }),
      },
    });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'failed');

    const after = await h.service.get(dto.id);
    expect(after.status).toBe('failed');
    // 失败原因要说清是**平台配置**问题，不是用户输入问题。
    expect(after.failureMessage ?? '').toContain('SHARED_TOKEN');
  });
});

describe('provision ④ —— 审计：注入了哪几份凭证进哪个沙箱', () => {
  it('⭐ 落一条 `sandbox.credentials.injected`，detail 里是 runtime id 列表', async () => {
    // 用户裁决②：凭证面扩大可以接受，但**要能事后查**。
    const h = harness({
      adapters: twoRuntimes(),
      supportedRuntimes: ['claude-code', 'codex'],
      credentialsByRuntime: {
        'claude-code': credWithEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'c' }),
        codex: credWithEnv({ OPENAI_API_KEY: 'o' }),
      },
    });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');

    const ev = h.auditRecords.find((e) => e.type === 'sandbox.credentials.injected');
    expect(ev).toBeDefined();
    expect(ev?.subjectId).toBe(dto.id);
    expect(ev?.detail?.['runtimeIds']).toEqual(['claude-code', 'codex']);
    expect(ev?.detail?.['defaultRuntime']).toBe('claude-code');
    expect(ev?.outcome).toBe('ok');
    // ⛔ 审计记身份不记材料：凭证内容一个字都不许进去。
    expect(JSON.stringify(ev)).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('一份都没注入也要记（`skipped`）—— 「这个盒子里什么都没有」同样是要查的事实', async () => {
    const h = harness({ adapters: twoRuntimes(), supportedRuntimes: ['claude-code'] });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');

    const ev = h.auditRecords.find((e) => e.type === 'sandbox.credentials.injected');
    expect(ev?.detail?.['runtimeIds']).toEqual([]);
    expect(ev?.outcome).toBe('skipped');
  });
});

describe('assertRunnable —— 判据从「等于默认」放宽成「在可用列表里」', () => {
  it('⭐ 另一个注入过凭证的 runtime **可以**发任务', async () => {
    const h = harness({
      adapters: twoRuntimes(),
      supportedRuntimes: ['claude-code', 'codex'],
      credentialsByRuntime: {
        'claude-code': credWithEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'c' }),
        codex: credWithEnv({ OPENAI_API_KEY: 'o' }),
      },
    });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');

    // 旧实现在这里会拒（`sandbox.runtime !== 'codex'`），理由写着「它的 CLI 和凭证是
    // 唯一装了的」—— 那句话在多 runtime 之后是假话。
    await expect(h.taskService.run(dto.id, 'codex', { prompt: 'hi' })).resolves.toBeDefined();
  });

  it('⛔ 沙箱里没有的 runtime 仍然被拒，且拒绝语**说的是真话**', async () => {
    const h = harness({
      adapters: [...twoRuntimes(), new FakeAdapter('acme', 'Acme', [])],
      supportedRuntimes: ['claude-code'],
      credentialsByRuntime: { 'claude-code': credWithEnv({ T: '1' }) },
    });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');

    await expect(h.taskService.run(dto.id, 'acme', { prompt: 'hi' })).rejects.toThrow(
      /没有可用的 'acme'|no usable 'acme'/,
    );
    // ⛔ 旧文案「its CLI and credential are the only ones installed」现在是假话，
    //    而一句假的拒绝语会把排查引向完全错误的方向。
    await expect(h.taskService.run(dto.id, 'acme', { prompt: 'hi' })).rejects.not.toThrow(
      /the only ones installed/,
    );
  });
});

describe('⛔ `availableRuntimes` 是**记录**，不是「备好了哪些」', () => {
  it('⭐ 某个 runtime 注入**失败** ⇒ 它不进列表（列表里只有真的成功了的）', async () => {
    // ⚠️ 这一条是「记录 vs 推导」唯一能验出差别的形状：全成功时"记备好的"与"记成功的"
    //    产出一模一样，只有有一个失败才分得开。注入验证抓到过这个缺口。
    const claude = new FakeAdapter('claude-code', 'Claude Code', []);
    const codex = new FakeAdapter('codex', 'Codex', []);
    codex.injectThrows = 'codex 的凭证写不进去';

    const h = harness({
      adapters: [claude, codex],
      supportedRuntimes: ['claude-code', 'codex'],
      credentialsByRuntime: {
        'claude-code': credWithEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'c' }),
        codex: credWithEnv({ OPENAI_API_KEY: 'o' }),
      },
    });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');

    const after = await h.service.get(dto.id);
    // codex 的凭证**没进去**，所以它不该出现在下拉里 —— 列出来就是点开必然失败的选项。
    expect(after.availableRuntimes).toEqual(['claude-code']);
    expect(h.injections).toEqual([`claude-code:${dto.id}`]);
    // 审计记的同样是**成功的那些**。
    const ev = h.auditRecords.find((e) => e.type === 'sandbox.credentials.injected');
    expect(ev?.detail?.['runtimeIds']).toEqual(['claude-code']);
  });

  it('⚠️ 单个注入失败**不拖垮整段 provision**（别的 runtime 与任务本身照常）', async () => {
    const claude = new FakeAdapter('claude-code', 'Claude Code', []);
    claude.injectThrows = 'boom';
    const h = harness({
      adapters: [claude],
      supportedRuntimes: ['claude-code'],
      credentialsByRuntime: { 'claude-code': credWithEnv({ T: '1' }) },
    });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    // 沙箱照样 running；只是这个 runtime 没登录（与"一个凭证都没配"同一种状态）。
    expect((await h.service.get(dto.id)).status).toBe('running');
    // 默认 runtime 永远在可用集里（CLI 是装了的），即使凭证没进去。
    expect((await h.service.get(dto.id)).availableRuntimes).toEqual(['claude-code']);
  });
});

describe('SandboxExecPort#bindingOf —— 终端读的是沙箱行，⛔ 不是现推', () => {
  it('⭐ binding 把沙箱行上的 `availableRuntimes` 原样交给终端', async () => {
    const h = harness({
      adapters: twoRuntimes(),
      supportedRuntimes: ['claude-code', 'codex'],
      credentialsByRuntime: {
        'claude-code': credWithEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'c' }),
        codex: credWithEnv({ OPENAI_API_KEY: 'o' }),
      },
    });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');

    const binding = await h.execPort.bindingOf(dto.id);
    // ⛔ 退化成 `[sandbox.runtime]`（现推/只给默认）会让「+ 新终端」下拉里永远只有一个
    //    CLI —— 界面上看不出是 bug，只会觉得"另一个怎么没出来"。
    expect([...binding.availableRuntimes].sort()).toEqual(['claude-code', 'codex']);
    expect(binding.runtimeId).toBe('claude-code'); // 默认那个仍在它自己的字段上
  });
});
