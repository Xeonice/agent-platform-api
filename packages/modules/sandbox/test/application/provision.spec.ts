import { beforeEach, describe, it, expect } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { SandboxId } from '@platform/shared-kernel';
import {
  RuntimeInstallFailedError,
  ImageContractViolationError,
  UnknownRuntimeError,
} from '@platform/contracts';
import { mapProviderErrorToHttp } from '../../src/application/provider-error.http';
import { FakeAdapter, FakeProvider, harness, waitForStatus } from './_harness';

/**
 * Application-layer tests with IN-MEMORY doubles (docs/backend/25) — NO docker.
 * Covers the full provision pipeline plus the S5 `starting` 段 cases
 * T-SBX-31 / 32 / 33 / 34 / 35 and E2E-1-bootstrap's application half.
 */
/** Control characters BUILT FROM ESCAPES — never pasted raw into a source file. */
const ESC = String.fromCharCode(0x1b);
const NUL = String.fromCharCode(0x00);

describe('SandboxApplicationService provision pipeline (in-memory doubles)', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('create() returns pending immediately, then provision drives it to running', async () => {
    // ASYNC (P1-#1): create returns early; provision runs in the background.
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    expect(dto.status).toBe('pending');

    await waitForStatus(h.service, dto.id, 'running');
    expect(h.provider.calls).toEqual(['create', 'start']);
    expect(h.wsCalls[0]).toMatch(/^prepare:/);

    const stored = await h.repo.findById(dto.id as SandboxId);
    expect(stored!.status).toBe('running');
    expect(stored!.providerSandboxId).toBe(`fake-${dto.id}`);
    const path = stored!.transitions.map((t) => t.to);
    expect(path).toEqual([
      'pending',
      'scheduling',
      'preparing-workspace',
      'creating',
      'starting',
      'running',
    ]);
  });

  it('destroy() stops + destroys + cleans the workspace and reaches destroyed', async () => {
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running'); // wait for background provision
    await h.service.destroy(dto.id, { keepVolume: false });
    const stored = await h.repo.findById(dto.id as SandboxId);
    expect(stored!.status).toBe('destroyed');
    expect(h.provider.calls).toContain('destroy');
    expect(h.wsCalls.some((c) => c.startsWith(`cleanup:${dto.id}:false`))).toBe(true);
  });

  it('rejects an unknown provider before creating anything', async () => {
    await expect(
      h.service.create({ projectId: 'prj-1', runtime: 'x', provider: 'nope' }),
    ).rejects.toThrow(/unknown provider/i);
  });

  /**
   * The sibling of the check above, for the OTHER open registry (14 §10).
   *
   * ⚠️ THIS IS THE ONE THE TYPE SYSTEM CANNOT COVER AND MUST NOT TRY TO. `runtime` is
   * `z.string().min(1)` on purpose — the adapter registry is *not a closed enum*
   * (04 §8) — so `'shell'` is a perfectly well-typed value on both sides of the wire,
   * and a real frontend shipped exactly that. Without a door check it travelled all the
   * way into the ASYNC provision and came back as `INSTALL_FAILED`, i.e. the platform
   * told the user its CLI failed to install.
   */
  it('rejects an unknown runtime before creating anything (04 §5 / 14 §10)', async () => {
    await expect(h.service.create({ projectId: 'prj-1', runtime: 'shell' })).rejects.toThrow(
      /unknown runtime/i,
    );
  });

  it('…and refusing it means NOTHING was scheduled, stored or provisioned', async () => {
    await expect(h.service.create({ projectId: 'prj-1', runtime: 'shell' })).rejects.toThrow();
    // 04 §5「不进调度、不落库、不调 provider.create」— all three, stated separately so a
    // regression says WHICH half of the promise broke.
    expect(h.provider.calls).toEqual([]);
    expect(h.wsCalls).toEqual([]);
    expect(h.repo.store.size).toBe(0);
    // and the project was never even looked up — the door closed before the facade.
    expect(h.projectLookups()).toBe(0);
  });

  it('accepts a runtime a third party registered at RUNTIME (the registry is the authority)', async () => {
    // The mirror image of the test above, and the reason this is a registry lookup
    // rather than a hard-coded list: an out-of-tree adapter registers through the same
    // `register()` (04 §8) and must be creatable without editing this service.
    h.runtimes.register(new FakeAdapter('acme-agent', 'Acme Agent'));
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'acme-agent' });
    expect(dto.runtime).toBe('acme-agent');
    // …and the display name comes from the adapter, not from a platform-side table.
    expect(dto.name).toMatch(/^Acme Agent · /);
  });

  it('rejects an image ref carrying a control character (not just whitespace)', async () => {
    // `\s` never covered NUL/BEL/ESC, though the comment claimed "control characters".
    // An ESC in a ref is a terminal-escape injection into every log that renders it.
    //
    // ⚠️ Built from escapes, never pasted raw: a literal 0x1b/0x00 in a source file makes
    // git treat it as BINARY (no diff, no review) and does not survive most editors.
    await expect(
      h.service.create({
        projectId: 'prj-1',
        runtime: 'claude-code',
        image: `alpine:3.20${ESC}[2J`,
      }),
    ).rejects.toThrow(/invalid image reference/i);
    await expect(
      h.service.create({ projectId: 'prj-1', runtime: 'claude-code', image: `alpine:3.20${NUL}` }),
    ).rejects.toThrow(/invalid image reference/i);
    // a perfectly ordinary ref still passes — the rule is control characters, not punctuation
    const ok = await h.service.create({
      projectId: 'prj-1',
      runtime: 'claude-code',
      image: 'registry.example.com:5000/team/img@sha256:abc123',
    });
    expect(ok.status).toBe('pending');
  });

  it('destroys the already-created container when start fails (P1-2, no orphan)', async () => {
    class FailingStartProvider extends FakeProvider {
      override async start(): Promise<void> {
        this.calls.push('start');
        throw new Error('agent never became ready');
      }
    }
    const failing = harness({ providers: [new FailingStartProvider('aio')] });

    const dto = await failing.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(failing.service, dto.id, 'failed');
    // create → start(threw) → destroy (teardown) — the container is not orphaned.
    expect(failing.provider.calls).toEqual(['create', 'start', 'destroy']);
    expect(failing.wsCalls.some((c) => c.startsWith('cleanup:'))).toBe(true);
  });
});

describe('T-SBX-31 — the `starting` 段 runs its five steps in the pinned order (03 §4.3)', () => {
  it('start → agent readiness → ensureRuntimeInstalled → injectCredential → bootstrap', async () => {
    const cred = injectableCredential();
    const h = harness({ credential: cred });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');

    const order = h.calls.filter((c) => c !== 'buildStartCommand' && c !== 'buildAttachCommand');
    expect(order).toEqual([
      'prepareRuntimeCredential',
      'provider.create',
      'provider.start',
      'agent-readiness-probe',
      'ensureRuntimeInstalled',
      'injectCredential',
      'recordRuntimeInjection',
      'bootstrapAgentSession',
    ]);
  });

  it('injectCredential comes AFTER provider.start — exec derives from spawn (04 §2.3)', async () => {
    const h = harness({ credential: injectableCredential() });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');

    // this is the assertion the old (wrong) design would have failed: it injected
    // BEFORE start, when no `exec` can exist at all.
    expect(h.calls.indexOf('injectCredential')).toBeGreaterThan(h.calls.indexOf('provider.start'));
    expect(h.injections).toEqual([`claude-code:${dto.id}`]);
  });

  it('env-form credential material reaches the sandbox at CREATE time (05 §4.1)', async () => {
    const h = harness({ credential: injectableCredential() });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    // claude's credential IS an env var; a per-call env would be visible in `ps`
    // inside the sandbox and cannot be added to an already-started process.
    expect(h.provider.lastContext?.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
    });
  });

  it('a missing credential is a loud WARNING, not a provisioning failure', async () => {
    const h = harness(); // no credential configured ⇒ facade throws NO_CREDENTIAL
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    expect(h.calls).not.toContain('injectCredential');
    expect(h.injections).toEqual([]);
  });
});

describe('T-SBX-32 — install writes never join the create transaction T1', () => {
  it('the runtime_installations write happens after T1 committed', async () => {
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    // T1 = the FIRST sandbox transaction, opened+closed inside create().
    const t1Index = h.txLog.indexOf('tx:sandbox');
    expect(t1Index).toBe(0);

    await waitForStatus(h.service, dto.id, 'running');
    const installTx = h.txLog.indexOf('tx:runtime_installations');
    expect(installTx).toBeGreaterThan(t1Index);
    // …and it is its OWN transaction, never nested inside a sandbox one.
    expect(h.txLog.filter((t) => t === 'tx:runtime_installations')).toHaveLength(1);
  });
});

describe('T-SBX-33 — install failure lands `failed` with a reason and the compensation', () => {
  it('starting → failed + failure_code INSTALL_FAILED + full teardown', async () => {
    const h = harness({ installError: new RuntimeInstallFailedError('npm exited 1') });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'failed');

    const stored = await h.repo.findById(dto.id as SandboxId);
    expect(stored!.status).toBe('failed');
    // the CODE is its own field — the frontend branches on it, and P22 §1 owns the
    // sentence. The prose stays detail-only and is never parsed for the code.
    expect(stored!.failureCode).toBe('INSTALL_FAILED');
    expect(stored!.failureReason).toBe('npm exited 1');
    // the transition really came from `starting`
    const path = stored!.transitions.map((t) => t.to);
    expect(path.slice(-2)).toEqual(['starting', 'failed']);
    // compensation identical to any other `starting` failure (24 §1.3)
    expect(h.provider.calls).toContain('destroy');
    expect(h.wsCalls.some((c) => c.startsWith(`cleanup:${dto.id}:false`))).toBe(true);
    // the agent session is never started for a sandbox that has no CLI
    expect(h.calls).not.toContain('bootstrapAgentSession');
  });
});

describe('async failures expose a CODE on both of their two outlets (04 §4)', () => {
  it('the WS projection of a failed transition carries errorCode', async () => {
    // provisioning is async: the caller already holds its 202, so this event is the
    // only LIVE channel a failure code has. `IMAGE_CONTRACT_VIOLATION` in particular
    // does NOT ride runtime.install_progress, so without this the frontend would have
    // nothing but generic fallback copy.
    const h = harness({ installError: new RuntimeInstallFailedError('npm exited 1') });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'failed');

    const stored = await h.repo.findById(dto.id as SandboxId);
    const failed = stored!.transitions.at(-1)!;
    expect(failed.to).toBe('failed');
    // the aggregate raised the code with the transition (the projector reads it off
    // the domain event — it never re-derives it from prose).
    expect(stored!.failureCode).toBe('INSTALL_FAILED');
  });

  it('the DTO carries the persisted code + detail, so a refresh still explains it', async () => {
    const h = harness({ installError: new RuntimeInstallFailedError('npm exited 1') });
    const created = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, created.id, 'failed');

    const dto = await h.service.get(created.id);
    expect(dto.failureCode).toBe('INSTALL_FAILED');
    expect(dto.failureMessage).toBe('npm exited 1');
    // …and it is a CODE, not a sentence: the frontend keys P22 §1 copy off it.
    expect(dto.failureCode).not.toMatch(/\s/);
  });

  it('an error with no code of its own still gets one (02 §6.2 — never code-less)', async () => {
    const h = harness({ bootstrapError: new Error('something unlabelled broke') });
    const created = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, created.id, 'failed');
    const dto = await h.service.get(created.id);
    expect(dto.failureCode).toBe('INTERNAL');
    expect(dto.failureMessage).toBe('something unlabelled broke');
  });

  it('a healthy sandbox carries neither field', async () => {
    const h = harness();
    const created = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, created.id, 'running');
    const dto = await h.service.get(created.id);
    expect(dto.failureCode).toBeUndefined();
    expect(dto.failureMessage).toBeUndefined();
  });

  /**
   * The SYNCHRONOUS outlet of the same table (04 §4). `UNKNOWN_RUNTIME` has no
   * synchronous producer today — the create door refuses first — but 02 §6.2 forbids a
   * code with no mapping, and the row it would otherwise inherit is wrong in both
   * halves: `INSTALL_FAILED` maps to 500 (a server fault, when this is the caller's
   * input) and is retryable (when nothing about retrying can ever help).
   */
  it('UNKNOWN_RUNTIME maps to 400 + non-retryable, NOT to INSTALL_FAILED’s 500', () => {
    const mapped = mapProviderErrorToHttp(new UnknownRuntimeError('shell'));
    expect(mapped).toBeInstanceOf(HttpException);
    const http = mapped as HttpException;
    expect(http.getStatus()).toBe(400);
    expect(http.getResponse()).toMatchObject({
      code: 'UNKNOWN_RUNTIME',
      retryable: false,
    });
    // the neighbouring row is unchanged — a real install failure is still a 500 the
    // caller may retry.
    const install = mapProviderErrorToHttp(new RuntimeInstallFailedError('npm exited 1'));
    expect((install as HttpException).getStatus()).toBe(500);
    expect((install as HttpException).getResponse()).toMatchObject({ retryable: true });
  });
});

describe('E2E-1-bootstrapNoTmux (application half) — tmux missing fails LOUDLY', () => {
  it('IMAGE_CONTRACT_VIOLATION → failed, no buildStartCommand, prompt NOT consumed', async () => {
    const h = harness({
      bootstrapError: new ImageContractViolationError('镜像缺少 tmux'),
    });
    const dto = await h.service.create({
      projectId: 'prj-1',
      runtime: 'claude-code',
      initialPrompt: '重构登录模块',
    });
    await waitForStatus(h.service, dto.id, 'failed');

    const stored = await h.repo.findById(dto.id as SandboxId);
    expect(stored!.failureCode).toBe('IMAGE_CONTRACT_VIOLATION');
    expect(stored!.failureReason).toContain('tmux');
    // ③ nothing was started ⇒ the instruction was NOT consumed (I-SBX-10): a task
    // whose session never started has not run its instruction.
    expect(stored!.initialTask.consumedAt).toBeUndefined();
    expect(stored!.initialTask.prompt).toBe('重构登录模块');
    // ④ compensation ran
    expect(h.provider.calls).toContain('destroy');
    expect(h.wsCalls.some((c) => c.startsWith(`cleanup:${dto.id}:false`))).toBe(true);
  });
});

describe('E2E-1-bootstrap (application half) — the agent session starts in provision', () => {
  it('with an initialPrompt: buildStartCommand is used and the prompt is consumed', async () => {
    const h = harness();
    const dto = await h.service.create({
      projectId: 'prj-1',
      runtime: 'claude-code',
      initialPrompt: '把 README 翻译成英文',
    });
    await waitForStatus(h.service, dto.id, 'running');

    // NO WS connection was ever made — this is exactly the gap 裁决 D-15 closes.
    expect(h.calls).toContain('bootstrapAgentSession');
    expect(h.adapter.startCommands).toHaveLength(1);
    expect(h.adapter.startCommands[0]).toMatchObject({
      prompt: '把 README 翻译成英文',
      headless: false,
      workdir: '/workspace',
    });
    const stored = await h.repo.findById(dto.id as SandboxId);
    expect(stored!.initialTask.consumedAt).toBeInstanceOf(Date);
  });

  it('without an initialPrompt: a session still starts, from buildAttachCommand', async () => {
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');

    expect(h.adapter.startCommands).toHaveLength(0);
    expect(h.adapter.attachCommandCalls).toBe(1);
    const stored = await h.repo.findById(dto.id as SandboxId);
    expect(stored!.initialTask.consumedAt).toBeUndefined();
  });
});

describe('T-SBX-34 — bootstrap runs for interactive tasks only', () => {
  it('headless=true does NOT start an agent session (its path is a later slice)', async () => {
    const h = harness();
    const dto = await h.service.create({
      projectId: 'prj-1',
      runtime: 'claude-code',
      headless: true,
      timeoutMinutes: 30,
      initialPrompt: 'run the test suite',
    });
    await waitForStatus(h.service, dto.id, 'running');

    expect(h.calls).toContain('ensureRuntimeInstalled');
    expect(h.calls).not.toContain('bootstrapAgentSession');
    const stored = await h.repo.findById(dto.id as SandboxId);
    expect(stored!.initialTask.consumedAt).toBeUndefined();
  });
});

describe('T-SBX-35 — a restart does NOT replay the initial instruction (I-SBX-10)', () => {
  it('the second provision uses buildAttachCommand, not buildStartCommand', async () => {
    const h = harness();
    const dto = await h.service.create({
      projectId: 'prj-1',
      runtime: 'claude-code',
      initialPrompt: '给项目加上 CI',
    });
    await waitForStatus(h.service, dto.id, 'running');
    expect(h.adapter.startCommands).toHaveLength(1);

    // stop, then re-provision the SAME aggregate. `stopped → starting` skips
    // preparing-workspace (the directory is still there) but re-runs the whole
    // `starting` 段 — the instance is a fresh process tree (I-SBX-9).
    const stored = await h.repo.findById(dto.id as SandboxId);
    stored!.transitionTo('stopping', 'reaper', new Date());
    stored!.transitionTo('stopped', 'reaper', new Date());
    await h.provision.restart(stored!, h.provider);

    // still ONE start command in total: the restart went down the attach path.
    expect(h.adapter.startCommands).toHaveLength(1);
    expect(h.adapter.attachCommandCalls).toBe(1);
  });
});

describe('image input is honoured (TASK-LAUNCH-DECISIONS §3★1)', () => {
  it('the requested image reaches provider.create AND getInstallPlan', async () => {
    const h = harness();
    const dto = await h.service.create({
      projectId: 'prj-1',
      runtime: 'claude-code',
      image: 'localhost:5001/agent-infra/sandbox:latest',
    });
    await waitForStatus(h.service, dto.id, 'running');

    expect(h.provider.lastContext?.image.ref).toBe('localhost:5001/agent-infra/sandbox:latest');
    expect(h.installInputs[0].image.ref).toBe('localhost:5001/agent-infra/sandbox:latest');
  });

  it('falls back to the platform default when none is given', async () => {
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    expect(h.provider.lastContext?.image.ref).toBe(
      process.env.SANDBOX_DEFAULT_IMAGE ?? 'alpine:3.20',
    );
  });

  it('rejects a malformed image reference before anything is written', async () => {
    const h = harness();
    await expect(
      h.service.create({ projectId: 'prj-1', runtime: 'claude-code', image: 'bad ref' }),
    ).rejects.toThrow(/invalid image reference/i);
    expect(h.repo.store.size).toBe(0);
  });
});

describe('the default task name is derived server-side (P21-1 §9)', () => {
  it('uses the adapter displayName when there is no instruction', async () => {
    const h = harness({ adapters: [new FakeAdapter('codex', 'Codex')] });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'codex' });
    expect(dto.name).toBe('Codex · 2026-08-21 00:00');
  });

  it('uses the first line of the instruction — and never echoes the instruction', async () => {
    const h = harness();
    const dto = await h.service.create({
      projectId: 'prj-1',
      runtime: 'claude-code',
      initialPrompt: '修复登录页的报错\n细节：看 issue #42',
    });
    expect(dto.name).toBe('修复登录页的报错…');
    expect(JSON.stringify(dto)).not.toContain('issue #42');
    expect(Object.keys(dto)).not.toContain('initialPrompt');
  });
});

function injectableCredential() {
  return {
    runtimeId: 'claude-code',
    obtainedVia: 'setup-token' as const,
    issuedAt: '2026-08-21T00:00:00.000Z',
    credentialFiles: [],
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' },
    zeroize(): void {},
  };
}
