import { mkdirSync, closeSync, openSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * SSH host-key pinning (docs/backend/03 §7.3 H). Public SaaS hosts
 * (github.com / gitlab.com / gitee.com) ship with PINNED host public keys and use
 * `StrictHostKeyChecking=yes` against a known_hosts file we write from these
 * constants — so a rebinding/MITM to a fake host presents a non-matching host key
 * and SSH aborts DURING the handshake, BEFORE the private key ever signs a
 * challenge. Only UNKNOWN self-hosted hosts fall back to `accept-new` (first-connect
 * TOFU), whose first-connect MITM risk is carried by network isolation (03 §7.3).
 *
 * PROVENANCE: the github.com / gitlab.com keys below were captured via ssh-keyscan
 * and VERIFIED to match each vendor's officially published SHA256 fingerprints:
 *   github ed25519 SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU
 *   github rsa     SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s
 *   gitlab ed25519 SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8
 *   gitlab rsa     SHA256:ROQFvPThGrW4RuWLoL9tq9I9zJ42fK4XywyRtbOz/EQ
 * gitee.com keys were captured via ssh-keyscan (gitee publishes fingerprints on its
 * help pages; the pinned values match what the host presents):
 *   gitee  ed25519 SHA256:+ULzij2u99B9eWYFTw1Q4ErYG/aepHLbu96PAUCoV88
 *   gitee  rsa     SHA256:meTsVSCgOas8fBnJyx8EPlUJr6iQ96riFmCFPfUkDtU
 * Keys rotate rarely; a rotation requires a code + fingerprint update (that is the
 * pin working as intended — a silent host-key change must fail, not auto-trust).
 */
const PINNED_ENTRIES: Record<string, string[]> = {
  'github.com': [
    'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
    'github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=',
  ],
  'gitlab.com': [
    'gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf',
    'gitlab.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCsj2bNKTBSpIYDEGk9KxsGh3mySTRgMtXL583qmBpzeQ+jqCMRgBqB98u3z++J1sKlXHWfM9dyhSevkMwSbhoR8XIq/U0tCNyokEi/ueaBMCvbcTHhO7FcwzY92WK4Yt0aGROY5qX2UKSeOvuP4D6TPqKF1onrSzH9bx9XUf2lEdWT/ia1NEKjunUqu1xOB/StKDHMoX4/OKyIzuS0q/T1zOATthvasJFoPrAjkohTyaDUz2LN5JoH839hViyEG82yB+MjcFV5MU3N1l1QL3cVUCh93xSaua1N85qivl+siMkPGbO5xR/En4iEY6K2XPASUEMaieWVNTRCtJ4S8H+9',
  ],
  'gitee.com': [
    'gitee.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEKxHSJ7084RmkJ4YdEi5tngynE8aZe2uEoVVsB/OvYN',
    'gitee.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDMzG3r+88lWSDK9fyjcZmYsWGDBDmGoAasKMAmjoFloGt9HRQX2Qp4f9FY2XK/hsHYinvoh5Xytl9iaUNUWMfYR8q6VEMtOO87DgoAFcfKZHt0/nbAg9RoNTKYt6v8tPwYpr7N0JP/01nE4LFsNDnstr6H0bXSAzbKWCETLZfdPV4l2uSpRn3bU0ugoZ0aSKz5Dc/IloBfGCTvkSsxUydMRd/Chpjt6VxncDbp+Fa6pzsseK8OQzrg6Fgc5783EN3EQqZ2skqyCwExtx95BJlfx1B3luZnWfpkwNDnrZRT/Qx0OrWqyf0q6f9uQr+UG1S8qDcUn3e/9onq3rwBri8/',
  ],
};

/** true when the host has pinned keys → use StrictHostKeyChecking=yes. */
export function isPinnedHost(host: string): boolean {
  return Object.prototype.hasOwnProperty.call(PINNED_ENTRIES, host.toLowerCase());
}

/**
 * Write (overwrite) the pinned known_hosts file and return its path. Overwriting on
 * every use guarantees the pinned entries cannot be poisoned by a prior write. Used
 * with `StrictHostKeyChecking=yes` for SaaS hosts.
 */
export function pinnedKnownHostsPath(): string {
  const dir = sshDir();
  const path = resolve(dir, 'pinned_known_hosts');
  const body = Object.values(PINNED_ENTRIES).flat().join('\n') + '\n';
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

/**
 * Platform-private TOFU `UserKnownHostsFile` for UNKNOWN self-hosted hosts, used
 * with `StrictHostKeyChecking=accept-new` (first connect recorded here; a LATER
 * host-key change fails the clone — the difference from `no`).
 */
export function platformKnownHostsPath(): string {
  const path = resolve(sshDir(), 'known_hosts');
  try {
    closeSync(openSync(path, 'a', 0o600)); // ensure it exists (accept-new appends)
  } catch {
    // best-effort; ssh will create it on first write if writable
  }
  return path;
}

function sshDir(): string {
  const dataRoot = process.env.DATA_ROOT ?? resolve(process.cwd(), 'data');
  const dir = resolve(dataRoot, '.ssh');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
