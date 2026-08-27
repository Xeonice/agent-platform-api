import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type {
  ProcessStream,
  SandboxHandle,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderContext,
} from '../sandbox-provider.contract';

/**
 * Runtime manifest of `SandboxProviderCapabilities` (04 §2.5). Declared as a
 * `Record<keyof …, true>` on purpose: adding an 8th capability bit to the interface
 * breaks THIS file at compile time, so the completeness check below can never
 * silently fall behind the contract.
 */
const CAPABILITY_MANIFEST: Record<keyof SandboxProviderCapabilities, true> = {
  spawnTty: true,
  volumeMount: true,
  updateResources: true,
  pauseResume: true,
  snapshot: true,
  watchEvents: true,
  headlessTask: true,
};
const CAPABILITY_KEYS = Object.keys(CAPABILITY_MANIFEST) as (keyof SandboxProviderCapabilities)[];

export interface SandboxProviderTestOptions {
  /** Pin the declared bits verbatim (regression guard for a built-in implementation). */
  expectedCapabilities?: Partial<SandboxProviderCapabilities>;
  /**
   * A ready-to-use provider context (image/quota already resolved). Supplying it
   * turns on the LIVE clauses — the ones that must really create a sandbox and
   * therefore need a reachable host (docker daemon / micro-VM hypervisor). Omit it
   * to run the STATIC clauses alone; the live block then reports as skipped rather
   * than silently disappearing.
   */
  context?: SandboxProviderContext;
  /**
   * A context whose IMAGE can really run the data plane, switching the DP-\* clauses
   * on (see `runDataPlaneClauses`). Deliberately separate from `context`: SP-01 only
   * needs `create()`+`destroy()` and is happily satisfied by a bare image (the e2e
   * hands `aio` an `alpine`), whereas DP-\* create → **start** → drive → destroy, and
   * a bare image would simply hang on the readiness gate. One knob per fixture cost.
   */
  dataPlaneContext?: SandboxProviderContext;
  /** Printed in the skipped block's title so a skip is never anonymous. */
  skipLiveReason?: string;
  skipDataPlaneReason?: string;
}

/**
 * Golden contract test suite (docs/backend/04 §10). REQUIRED CI check (09 §2.3).
 * Built-in (`aio`/`boxlite`) and third-party providers run the SAME suite — no
 * double standard. Clause ids follow 04 §10.2.
 *
 * Clause split:
 *   - STATIC (always run, no host needed): SP-00, CAP-01 (structural half), CAP-02.
 *   - LIVE   (need `opts.context` + a reachable host): SP-01.
 */
export function runSandboxProviderContractTests(
  label: string,
  factory: () => SandboxProvider,
  opts: SandboxProviderTestOptions = {},
): void {
  describe(`SandboxProvider contract: ${label}`, () => {
    it('SP-00 (MUST): `name` is a non-empty registry key', () => {
      const provider = factory();
      expect(typeof provider.name).toBe('string');
      expect(provider.name.trim()).not.toBe('');
    });

    it('CAP-01 (MUST, structural half): capabilities is a COMPLETE boolean struct', () => {
      const caps = factory().capabilities;
      for (const key of CAPABILITY_KEYS) {
        expect(typeof caps[key], `capability bit '${key}' must be a boolean`).toBe('boolean');
      }
      if (opts.expectedCapabilities) {
        for (const [key, value] of Object.entries(opts.expectedCapabilities)) {
          expect(caps[key as keyof SandboxProviderCapabilities], `capability bit '${key}'`).toBe(
            value,
          );
        }
      }
    });

    it('CAP-02 (MUST): every capability bit backed by a plane agrees with that plane', () => {
      const provider = factory();
      // A bit that lies in either direction is a real failure, not a nit: `true` with no
      // plane makes the application layer call `undefined`, and `false` with a plane
      // present hides a working capability from `GET /api/providers` — and therefore
      // from the UI, which drives its controls off exactly these bits.
      expect(
        provider.jobs !== undefined,
        '`capabilities.headlessTask` must equal the presence of `jobs`',
      ).toBe(provider.capabilities.headlessTask);
      expect(
        provider.files !== undefined,
        '`capabilities.headlessTask` must equal the presence of `files`',
      ).toBe(provider.capabilities.headlessTask);
    });

    const context = opts.context;
    if (context) {
      describe('live clauses (a real sandbox host is reachable)', () => {
        it('SP-01 (MUST): created handle.provider === provider.name', async () => {
          const provider = factory();
          const handle = await provider.create(context);
          try {
            expect(handle.provider).toBe(provider.name);
          } finally {
            await provider.destroy(handle);
          }
        });
      });
    } else {
      describe.skip(`live clauses SKIPPED — ${opts.skipLiveReason ?? 'no SandboxProviderContext supplied'}`, () => {
        it('SP-01 (MUST): created handle.provider === provider.name', () => undefined);
      });
    }

    runDataPlaneClauses(factory, opts);
  });
}

/**
 * ── 数据面条款（DP-\*）：本次从「只写在共用实现注释里」提升成断言的那一批 ────────
 *
 * 为什么非提不可，写在 SANDBOX-RUNTIME-DECISIONS 决策 A 修订里：`startJob` 的
 * ordering 那类规则**只存在于 `aio` 那份共用实现的注释中**，boxlite 靠「复用同一份
 * 实现」蹭到了它。共享实现保证的是「两边一样」，而它一旦对某个 provider 不适用，
 * 「一样」就变成**一起错** —— 这次就是。数据面拆成两份实现之后，唯一还能兜住
 * 「两边行为一致」的，就是这里。
 *
 * ⚠️ 条款写的是**可观察的后果**，不是某一方的实现步骤。举例：aio 那条规则的原文是
 * 「必须先建 session、再 exec、最后才 attach，否则平台重启时正在跑的作业会静默死掉」
 * —— 「先建 session」是 aio 的内情，第三方 provider 根本没有 session；能进契约的是
 * 后半句：**读的人走了，作业照跑；换一个全新的 provider 实例回来，凭持久化的
 * `JobHandle` + `JobCursor` 仍能读到剩下的输出和退出码**（DP-02）。
 *
 * 这些条款需要一个**真的跑得起来的沙箱**（create → start → 数据面 → destroy），
 * 比 SP-01 重得多，所以走**独立的开关** `dataPlaneContext`：SP-01 的 `context` 可以
 * 是一张跑不了数据面的裸镜像（e2e 里 aio 用的就是 `alpine`），拿它来跑这些条款只会
 * 在就绪门槛上卡死。没给就 **skip loud**，绝不静默消失。
 */
function runDataPlaneClauses(
  factory: () => SandboxProvider,
  opts: SandboxProviderTestOptions,
): void {
  const context = opts.dataPlaneContext;
  if (!context) {
    describe.skip(`data-plane clauses SKIPPED — ${opts.skipDataPlaneReason ?? 'no dataPlaneContext supplied'}`, () => {
      it('DP-01..DP-06', () => undefined);
    });
    return;
  }

  describe('data-plane clauses (a real sandbox is created, started and driven)', () => {
    let provider: SandboxProvider;
    let handle: SandboxHandle;

    beforeAll(async () => {
      provider = factory();
      handle = await provider.create(context);
      await provider.start(handle);
    }, DATA_PLANE_SETUP_TIMEOUT_MS);

    afterAll(async () => {
      if (handle) await provider.destroy(handle).catch(() => undefined);
    }, DATA_PLANE_SETUP_TIMEOUT_MS);

    it(
      'DP-01 (MUST): spawn(tty:false) honours cmd/env/cwd and reports the real exit code',
      async () => {
        const first = await collect(
          await provider.spawn(handle, {
            cmd: ['sh', '-c', 'printf "%s@%s" "$DP_PROBE" "$(pwd)"; exit 7'],
            tty: false,
            env: { DP_PROBE: 'dp-value' },
            cwd: '/etc',
          }),
        );
        // 一条断言同时钉住三件事，因为它们是同一次调用的三个字段:值到了、cwd 到了、
        // 退出码是命令自己的(而不是被实现吞掉换成 0)。
        expect(first.output).toContain('dp-value@/etc');
        expect(first.code).toBe(7);
      },
      DATA_PLANE_STEP_TIMEOUT_MS,
    );

    it(
      'DP-02 (MUST): a job SURVIVES the reader going away — a FRESH provider instance resumes it',
      async () => {
        if (!provider.jobs) return; // headlessTask=false ⇒ 本条不适用(CAP-02 已钉住一致性)
        const job = await provider.jobs.startJob(handle, {
          cmd: [
            'sh',
            '-c',
            'i=1; while [ $i -le 6 ]; do echo dp-line-$i; sleep 1; i=$((i+1)); done; exit 3',
          ],
        });
        // 读一次就“走人”:不 release、不 kill,把 handle + cursor 当成刚落库的那两列。
        const early = await provider.jobs.readJob(handle, job, undefined, { waitMs: 4000 });
        expect(early.status).toBe('running');

        // ⚠️ 这里换一个**全新的 provider 实例**,等价于「后端重启了」:进程内的任何
        // 连接、session、缓存都不在了,只剩下能过一趟数据库的那两个字符串。
        const revived = factory();
        let chunk = await revived.jobs!.readJob(handle, job, early.cursor, { waitMs: 10_000 });
        let out = early.stdout + chunk.stdout;
        for (let i = 0; i < 20 && chunk.status === 'running'; i++) {
          chunk = await revived.jobs!.readJob(handle, job, chunk.cursor, { waitMs: 5_000 });
          out += chunk.stdout;
        }
        expect(chunk.status).toBe('exited');
        // 输出没有断层,退出码也还在 —— 「读的人走了会把作业连输出一起带走」是
        // 这一条唯一要挡的失效,它只在重启之后才现形。
        expect(out).toContain('dp-line-1');
        expect(out).toContain('dp-line-6');
        expect(chunk.exitCode).toBe(3);

        await revived.jobs!.releaseJob(handle, job);
      },
      DATA_PLANE_JOB_TIMEOUT_MS,
    );

    it(
      'DP-03 (MUST): killJob does NOT release — the output and exit status survive the kill',
      async () => {
        if (!provider.jobs) return;
        const job = await provider.jobs.startJob(handle, {
          cmd: ['sh', '-c', 'echo dp-before-kill; sleep 120'],
        });
        const first = await provider.jobs.readJob(handle, job, undefined, { waitMs: 10_000 });
        expect(first.stdout).toContain('dp-before-kill');

        await provider.jobs.killJob(handle, job);
        // 杀完之后调用方最想要的恰恰是退出状态和输出的尾巴 —— 所以 kill 不许顺手
        // release(release 会把两者一起删掉)。
        const after = await provider.jobs.readJob(handle, job, undefined, { waitMs: 5_000 });
        expect(after.status).toBe('exited');
        expect(after.stdout).toContain('dp-before-kill');

        // DP-04: release 幂等 —— 已 release / 根本不认识的作业都静默成功。
        await provider.jobs.releaseJob(handle, job);
        await provider.jobs.releaseJob(handle, job);
      },
      DATA_PLANE_JOB_TIMEOUT_MS,
    );

    it(
      'DP-05 (MUST): readFile answers null for a missing file instead of throwing',
      async () => {
        if (!provider.files) return;
        // 契约把「文件不存在」写成正常路径而不是错误,理由是实测:codex 的
        // `-o/--output-last-message <FILE>` 在任务失败时根本不会被创建。
        await expect(
          provider.files.readFile(handle, '/tmp/dp-definitely-not-here-4f2a'),
        ).resolves.toBeNull();
        await expect(
          provider.files.openFileStream(handle, '/tmp/dp-definitely-not-here-4f2a'),
        ).resolves.toBeNull();
      },
      DATA_PLANE_STEP_TIMEOUT_MS,
    );

    it(
      'DP-06 (MUST): the file plane is BINARY SAFE and creates missing parents',
      async () => {
        if (!provider.files) return;
        // 0x00 / 0xa3 / 0xff:文本通道会在这三个字节上出事(实测 aio 的 text read
        // 端点直接抛 `'utf-8' codec can't decode byte 0xa3`)。逐字节比对,不比字符串。
        const payload = Buffer.from([0x00, 0x01, 0xa3, 0xff, 0x0a, 0x41, 0xc3, 0x28, 0x7f]);
        const path = `/var/tmp/dp-binary-${Math.floor(Math.random() * 1e9)}/nested/blob.bin`;
        await provider.files.writeFile(handle, path, payload);
        const read = await provider.files.readFile(handle, path);
        expect(read?.equals(payload)).toBe(true);

        const dir = path.slice(0, path.lastIndexOf('/'));
        const entries = await provider.files.listFiles(handle, dir);
        const row = entries.find((e) => e.path.endsWith('blob.bin'));
        expect(row?.kind).toBe('file');
        expect(row?.size).toBe(payload.length);
        // 目录的 size 必须**缺席**而不是 0(aio 的 agent 对目录报 `size: null`);
        // 两边形状不一致的话,同一段应用代码会在两个 provider 上看到不同的 JSON。
        const parents = await provider.files.listFiles(handle, dir.slice(0, dir.lastIndexOf('/')));
        const dirRow = parents.find((e) => e.kind === 'dir');
        expect(dirRow === undefined || dirRow.size === undefined).toBe(true);
      },
      DATA_PLANE_STEP_TIMEOUT_MS,
    );
  });
}

/**
 * 预算按**微 VM 的量级**定,不是按容器。实测:同一条 `codex --version`,docker 里 44ms、
 * 微 VM 里 **18.6s**(420×);冷 image store 首次 boot 要现拉现铺,量级 ~220s。
 * 拿容器的秒级预算套上来,红的会是超时而不是缺陷。
 */
const DATA_PLANE_SETUP_TIMEOUT_MS = 600_000;
const DATA_PLANE_STEP_TIMEOUT_MS = 120_000;
const DATA_PLANE_JOB_TIMEOUT_MS = 300_000;

/** 把一条 `ProcessStream` 收成 `{output, code}` —— 即 04 §2.3 的 `toExecFn` 语义。 */
function collect(stream: ProcessStream): Promise<{ output: string; code: number | null }> {
  return new Promise((resolve) => {
    let output = '';
    stream.onData((chunk) => {
      output += chunk.toString('utf8');
    });
    stream.onExit((code) => resolve({ output, code }));
  });
}
