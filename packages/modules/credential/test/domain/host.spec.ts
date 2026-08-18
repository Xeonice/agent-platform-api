import { describe, it, expect } from 'vitest';
import {
  defaultPortForKind,
  hostAllowed,
  normalizeAllowedHost,
  toAuthority,
} from '../../src/domain/services/host.util';

describe('authority normalisation (03 §7.3 C4 — git credential matching is port-sensitive)', () => {
  it('toAuthority: default port omitted, non-default port kept', () => {
    expect(toAuthority('GitHub.com', null, 'https')).toBe('github.com');
    expect(toAuthority('github.com', 443, 'https')).toBe('github.com'); // https default
    expect(toAuthority('git.company.com', 8443, 'https')).toBe('git.company.com:8443');
    expect(toAuthority('git.company.com', 22, 'ssh')).toBe('git.company.com'); // ssh default
    expect(toAuthority('git.company.com', 2222, 'ssh')).toBe('git.company.com:2222');
    expect(toAuthority('[::1]', 8443, 'https')).toBe('::1:8443'); // unbracketed
  });

  it('normalizeAllowedHost: canonicalises user input, dropping the type default port', () => {
    expect(normalizeAllowedHost('GitHub.com', 443)).toBe('github.com');
    expect(normalizeAllowedHost('github.com:443', 443)).toBe('github.com'); // default → dropped
    expect(normalizeAllowedHost('git.company.com:8443', 443)).toBe('git.company.com:8443');
    expect(normalizeAllowedHost('git.company.com:22', 22)).toBe('git.company.com'); // ssh default
    expect(normalizeAllowedHost('[fc00::1]:8443', 443)).toBe('fc00::1:8443');
  });

  it('defaultPortForKind maps kind → scheme default', () => {
    expect(defaultPortForKind('git-https-token')).toBe(443);
    expect(defaultPortForKind('git-ssh-key')).toBe(22);
  });

  it('hostAllowed: EXACT authority match (I-CRD-8) — port matters', () => {
    expect(hostAllowed('github.com', ['github.com'])).toBe(true);
    // a non-default port is part of the authority: with-port must match with-port.
    expect(hostAllowed('git.company.com:8443', ['git.company.com:8443'])).toBe(true);
    expect(hostAllowed('git.company.com:8443', ['git.company.com'])).toBe(false); // port mismatch
    expect(hostAllowed('git.company.com', ['git.company.com:8443'])).toBe(false);
    expect(hostAllowed('evil.example.com', ['github.com'])).toBe(false);
    expect(hostAllowed('192.168.1.10', ['192.168.1.10'])).toBe(true); // private LAN allowed when whitelisted
  });
});
