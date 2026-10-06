import { describe, expect, it } from 'vitest';
import {
  darwinMicroVmVerdict,
  linuxKvmVerdict,
  microVmPlan,
} from '../../../apps/api/src/platform/system/diagnostics/checks/dev-kvm.check';
import { reflinkOutcome } from '../../../apps/api/src/platform/system/diagnostics/checks/data-root-fs.check';

describe('AC-DIA-011/016 · environment facts stay distinct from measurement failure', () => {
  it('judges a supported Apple Silicon host by its own framework, and never suggests /dev/kvm on Windows', () => {
    expect(
      darwinMicroVmVerdict(
        { arch: 'arm64', darwinRelease: '25.0', hvSupport: true, frameworkPresent: true },
        true,
      ).status,
    ).toBe('ok');
    const other = microVmPlan('win32');
    expect(other.kind).toBe('unsupported');
    expect(JSON.stringify(other)).not.toContain('/dev/kvm');
  });
  it('a missing KVM device only warns when the default provider actually needs it', () => {
    expect(linuxKvmVerdict('ENOENT', true).status).toBe('warn');
    expect(linuxKvmVerdict('ENOENT', false).status).toBe('info');
    expect(linuxKvmVerdict(null, true).status).toBe('ok');
  });
  it('a failed reflink measurement remains unknown information; known unsupported Linux is warning with a usable copy fallback', () => {
    const unknown = reflinkOutcome(
      { kind: 'unknown', reason: 'probe command could not run' },
      { root: '/actual', fsLabel: 'APFS', os: 'darwin' },
    );
    expect(unknown.status).toBe('info');
    expect(unknown.headline).not.toContain('不支持');
    const unsupported = reflinkOutcome(
      { kind: 'unsupported', reason: 'clone rejected' },
      { root: '/actual', fsLabel: 'ext4', os: 'linux' },
    );
    expect(unsupported.status).toBe('warn');
    expect(unsupported.detailText).toContain('完整副本。不改也能用');
  });
});
