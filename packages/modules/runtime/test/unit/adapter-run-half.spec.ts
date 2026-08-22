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
    expect(cmd.cmd).toEqual(['codex', '-s', 'danger-full-access', 'fix the login bug']);
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
    expect(cmd.cmd).toEqual(['claude', '--dangerously-skip-permissions', 'translate the README']);
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
