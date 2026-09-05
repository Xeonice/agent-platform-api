import { describe, it, expect } from 'vitest';
import type { Clock, EventBus, IdGenerator, Tx, UnitOfWork } from '@platform/shared-kernel';
import { RuntimeInstallFailedError, UnknownRuntimeError } from '@platform/contracts';
import type {
  AuditRecorder,
  AuditRecordInput,
  ResolvedImageSpec,
  RuntimeAdapter,
  RuntimeAdapterRegistry,
  RuntimeInstallPlan,
  SandboxCommand,
  SandboxExecFn,
} from '@platform/contracts';
import { RuntimeInstallOrchestratorService } from '../../src/application/runtime-install.orchestrator';
import { RuntimeInstallationStateChanged } from '../../src/domain/events/runtime-events';
import type { RuntimeInstallation } from '../../src/domain/entities/runtime-installation.entity';
import type { RuntimeInstallationRepository } from '../../src/domain/repositories/runtime-installation.repository';

/**
 * `ensureRuntimeInstalled` — step ③ of the `starting` 段 (03 §4.3 ③, 13 §2.3.2).
 * Covers the three-step orchestration, the `installing` intermediate state really
 * existing, the loud failure when a `preinstalled` claim is disproved, and the
 * per-state-change WS-source events.
 */
const IMAGE: ResolvedImageSpec = { ref: 'example.invalid/img:tag', digest: 'sha256:x' };

class StubAdapter implements RuntimeAdapter {
  readonly displayName = 'Stub';
  readonly vendor = 'Stub';
  installCalls = 0;
  probeResults: boolean[] = [];

  constructor(
    readonly id: string,
    private readonly plan: RuntimeInstallPlan,
  ) {}

  loginCommand(): string[] {
    return [this.id];
  }
  getAuthMethods(): ['api-key'] {
    return ['api-key'];
  }
  async beginAuth(): Promise<never> {
    throw new Error('not used');
  }
  async completeAuth(): Promise<never> {
    throw new Error('not used');
  }
  async injectCredential(): Promise<void> {}
  getInstallPlan(): RuntimeInstallPlan {
    return this.plan;
  }
  async isInstalled(): Promise<boolean> {
    return this.probeResults.shift() ?? false;
  }
  // ⚠️ 参数要照契约声明出来（`SandboxExecFn`）：子类 `InstallingAdapter` 覆盖它时
  //    要用到，而父类不声明就成了「重写签名不兼容」（TS2416）。
  async install(_exec: SandboxExecFn): Promise<void> {
    this.installCalls += 1;
  }
  buildStartCommand(): SandboxCommand {
    return { cmd: [this.id] };
  }
  buildAttachCommand(): SandboxCommand {
    return { cmd: [this.id] };
  }
}

class InMemoryInstallRepo implements RuntimeInstallationRepository {
  readonly rows = new Map<string, RuntimeInstallation>();
  async find(sandboxId: string, runtimeId: string): Promise<RuntimeInstallation | null> {
    return this.rows.get(`${sandboxId}:${runtimeId}`) ?? null;
  }
  async listBySandbox(sandboxId: string): Promise<RuntimeInstallation[]> {
    return [...this.rows.values()].filter((r) => r.sandboxId === sandboxId);
  }
  saveSync(_tx: Tx, installation: RuntimeInstallation): void {
    this.rows.set(`${installation.sandboxId}:${installation.runtimeId}`, installation);
  }
}

function harness(adapter: StubAdapter) {
  const registry: RuntimeAdapterRegistry = {
    register: () => {},
    get: () => adapter,
    has: (id) => id === adapter.id,
    list: () => [adapter],
  };
  const repo = new InMemoryInstallRepo();
  const txCount = { n: 0 };
  const uow: UnitOfWork = {
    run: (fn) => {
      txCount.n += 1;
      return fn({} as Tx);
    },
  };
  const published: RuntimeInstallationStateChanged[] = [];
  const events: EventBus = {
    publishInTx: (_tx, batch) => {
      for (const e of batch) {
        if (e instanceof RuntimeInstallationStateChanged) published.push(e);
      }
    },
    subscribe: () => {},
  };
  const clock: Clock = { now: () => new Date('2026-08-21T00:00:00.000Z') };
  let n = 0;
  const ids: IdGenerator = { next: () => `rin-${++n}` };
  const execCalls: string[][] = [];
  const exec: SandboxExecFn = async (cmd) => {
    execCalls.push(cmd);
    return { stdout: 'stub 9.9.9\n', stderr: '', exitCode: 0 };
  };
  // 记录式审计 double —— `sandbox.probe` 的断言直接读它（03 §7.8）。
  const auditRecords: AuditRecordInput[] = [];
  const audit: AuditRecorder = { record: (r) => void auditRecords.push(r) };
  const service = new RuntimeInstallOrchestratorService(
    registry,
    repo,
    uow,
    events,
    clock,
    ids,
    audit,
  );
  return { service, repo, published, exec, execCalls, txCount, auditRecords };
}

const plan = (over: Partial<RuntimeInstallPlan> = {}): RuntimeInstallPlan => ({
  strategy: 'install-on-start',
  packageManagerCmds: ['npm install -g stub'],
  requiredBinaries: ['stub'],
  envRequirements: [],
  ...over,
});

describe('ensureRuntimeInstalled — the three steps (03 §4.3 ③)', () => {
  it('a preinstalled CLI is recorded `installed` with a PROBED version, no install', async () => {
    const adapter = new StubAdapter('stub', plan({ strategy: 'preinstalled' }));
    adapter.probeResults = [true];
    const h = harness(adapter);

    await h.service.ensureInstalled({
      sandboxId: 's1',
      runtimeId: 'stub',
      image: IMAGE,
      exec: h.exec,
    });

    const row = await h.repo.find('s1', 'stub');
    expect(row!.status).toBe('installed');
    // I-RIN-2: the version comes from a REAL `--version` run against the binary the
    // PLAN names, never inferred from a path (04 §2.1★).
    expect(row!.versionDetected).toBe('stub 9.9.9');
    expect(h.execCalls).toContainEqual(['stub', '--version']);
    expect(adapter.installCalls).toBe(0);
  });

  it('an absent CLI goes not_installed → installing → installed, and `installing` is REAL', async () => {
    const adapter = new StubAdapter('stub', plan());
    adapter.probeResults = [false, true]; // absent, then present after install
    const h = harness(adapter);

    await h.service.ensureInstalled({
      sandboxId: 's1',
      runtimeId: 'stub',
      image: IMAGE,
      exec: h.exec,
    });

    expect(adapter.installCalls).toBe(1);
    // the intermediate state must really be emitted: a cold claude-code install was
    // measured at 753s, and a minute-scale window with no state cannot be explained.
    expect(h.published.map((e) => e.status)).toEqual(['not_installed', 'installing', 'installed']);
    expect((await h.repo.find('s1', 'stub'))!.status).toBe('installed');
  });

  it('每次状态变更各自一个短事务 — never one big transaction', async () => {
    const adapter = new StubAdapter('stub', plan());
    adapter.probeResults = [false, true];
    const h = harness(adapter);
    await h.service.ensureInstalled({
      sandboxId: 's1',
      runtimeId: 'stub',
      image: IMAGE,
      exec: h.exec,
    });
    expect(h.txCount.n).toBe(h.published.length);
  });

  it('re-verifies via PATH after install — "npm said ok" is not proof (04 §2.1★)', async () => {
    const adapter = new StubAdapter('stub', plan());
    adapter.probeResults = [false, false]; // install "succeeds" but nothing on PATH
    const h = harness(adapter);

    await expect(
      h.service.ensureInstalled({ sandboxId: 's1', runtimeId: 'stub', image: IMAGE, exec: h.exec }),
    ).rejects.toBeInstanceOf(RuntimeInstallFailedError);
    const row = await h.repo.find('s1', 'stub');
    expect(row!.status).toBe('failed');
    expect(row!.error).toMatch(/still not on PATH/);
  });

  it('a `preinstalled` claim the live probe disproves fails LOUDLY, it does not install', async () => {
    const adapter = new StubAdapter(
      'stub',
      plan({ strategy: 'preinstalled', packageManagerCmds: [] }),
    );
    adapter.probeResults = [false];
    const h = harness(adapter);

    await expect(
      h.service.ensureInstalled({ sandboxId: 's1', runtimeId: 'stub', image: IMAGE, exec: h.exec }),
    ).rejects.toThrow(/declares 'stub' as preinstalled/);
    // installing anyway would hide a broken image contract behind a long pause —
    // the same discipline as the tmux self-check.
    expect(adapter.installCalls).toBe(0);
    expect((await h.repo.find('s1', 'stub'))!.status).toBe('failed');
  });

  it('an install failure surfaces as INSTALL_FAILED and records the reason', async () => {
    const adapter = new StubAdapter('stub', plan());
    adapter.probeResults = [false];
    adapter.install = async () => {
      throw new Error('npm exited 1');
    };
    const h = harness(adapter);

    await expect(
      h.service.ensureInstalled({ sandboxId: 's1', runtimeId: 'stub', image: IMAGE, exec: h.exec }),
    ).rejects.toMatchObject({ code: 'INSTALL_FAILED' });
    const row = await h.repo.find('s1', 'stub');
    expect(row!.status).toBe('failed');
    expect(row!.error).toContain('npm exited 1');
    expect(h.published.at(-1)!.status).toBe('failed');
  });

  it('I-RIN-1: a re-provision re-states the SAME row, it does not add a second one', async () => {
    const adapter = new StubAdapter('stub', plan({ strategy: 'preinstalled' }));
    adapter.probeResults = [true, true];
    const h = harness(adapter);

    await h.service.ensureInstalled({
      sandboxId: 's1',
      runtimeId: 'stub',
      image: IMAGE,
      exec: h.exec,
    });
    await h.service.ensureInstalled({
      sandboxId: 's1',
      runtimeId: 'stub',
      image: IMAGE,
      exec: h.exec,
    });
    expect(await h.repo.listBySandbox('s1')).toHaveLength(1);
  });

  /**
   * ⚠️ THIS TEST USED TO ASSERT `INSTALL_FAILED`, AND THAT WAS THE BUG IT PINNED IN
   * PLACE (14 §10 / 04 §4). An id with no adapter is not a failed install: nothing was
   * installed and nothing could be, so the platform was telling the user 「运行时 CLI
   * 安装失败(该镜像未预装,现装未成功)」 about a runtime that has no CLI to install —
   * and, because `INSTALL_FAILED` is retryable, offering a retry that cannot ever work.
   */
  it('an unknown runtime is UNKNOWN_RUNTIME — its own code, not INSTALL_FAILED', async () => {
    const h = harness(new StubAdapter('stub', plan()));
    const call = h.service.ensureInstalled({
      sandboxId: 's1',
      runtimeId: 'nope',
      image: IMAGE,
      exec: h.exec,
    });
    await expect(call).rejects.toBeInstanceOf(UnknownRuntimeError);
    await expect(call).rejects.toMatchObject({ code: 'UNKNOWN_RUNTIME', retryable: false });
    // …and it is still not a crash: it carries a code, so `failureOf` can file it
    // (02 §6.2 forbids a code-less failure).
    await expect(call).rejects.not.toBeInstanceOf(RuntimeInstallFailedError);
  });
});

/**
 * `sandbox.probe`（03 §7.8）—— 补的是「探测失败只有一行 message」。
 *
 * MUTATION 记录（实际跑过）：把 `probeExec` 换回裸 `input.exec` ⇒ 第一条红。
 */
describe('探测审计（03 §7.8 sandbox.probe）', () => {
  it('每次探测落一条 sandbox.probe，带 argv / exitCode / 耗时', async () => {
    const adapter = new StubAdapter('stub', plan({ strategy: 'preinstalled' }));
    adapter.probeResults = [true];
    const h = harness(adapter);
    await h.service.ensureInstalled({
      sandboxId: 's1',
      runtimeId: 'stub',
      image: IMAGE,
      exec: h.exec,
    });
    const probes = h.auditRecords.filter((r) => r.type === 'sandbox.probe');
    expect(probes.length).toBeGreaterThan(0);
    expect(probes[0]).toMatchObject({
      category: 'sandbox',
      subjectType: 'sandbox',
      subjectId: 's1',
      outcome: 'ok',
    });
    expect(Array.isArray(probes[0]!.detail?.argv)).toBe(true);
    expect(typeof probes[0]!.durationMs).toBe('number');
  });

  /**
   * ⚠️ **安装本身刻意不记。** 一次冷装是 753s、上万行 npm 输出（04 §3 ★1）；
   * 把它逐条灌进审计流就是 P21-5 §10.1 明令禁止的「把运行日志灌进审计面板」。
   */
  it('install() 自己跑的命令不进审计流 —— 只有探测进', async () => {
    // 一个会真的 exec 的 install（真 adapter 都会：`npm i -g …`）。
    class InstallingAdapter extends StubAdapter {
      override async install(exec: SandboxExecFn): Promise<void> {
        await exec(['npm', 'install', '-g', '@anthropic-ai/claude-code']);
      }
    }
    const adapter = new InstallingAdapter('stub', plan());
    adapter.probeResults = [false, true];
    const h = harness(adapter);
    await h.service.ensureInstalled({
      sandboxId: 's1',
      runtimeId: 'stub',
      image: IMAGE,
      exec: h.exec,
    });
    const probes = h.auditRecords.filter((r) => r.type === 'sandbox.probe');
    const probedArgv = probes.map((r) => (r.detail?.argv as string[])[0]);
    expect(h.execCalls.map((c) => c[0])).toContain('npm');
    // ⚠️ npm 那一条**不在**审计流里 —— 一次冷装 753s、上万行输出（04 §3 ★1）。
    expect(probedArgv).not.toContain('npm');
    expect(probes.length).toBeLessThan(h.execCalls.length);
  });
});
