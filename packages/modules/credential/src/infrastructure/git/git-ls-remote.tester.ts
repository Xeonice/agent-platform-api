import { tmpdir } from 'node:os';
import { Injectable } from '@nestjs/common';
import { simpleGit } from 'simple-git';
import type {
  GitLsRemoteErrorCode,
  GitLsRemoteInput,
  GitLsRemoteResult,
  GitRemoteTester,
} from '../../domain/ports/git-remote-tester.port';
import { buildChildEnv, buildUnsafe } from './git-spawn';

const LS_REMOTE_TIMEOUT_MS = 15_000; // 03 §7.4

/**
 * `git ls-remote --exit-code` connection tester (docs/backend/03 §7.4). 15s hard
 * cap (wall-clock abort + simple-git block timeout). Returns ONLY {ok, errorCode?,
 * message?} — never a ref list (would leak private branch names). The message is
 * sanitized before it is returned.
 */
@Injectable()
export class GitLsRemoteTester implements GitRemoteTester {
  async lsRemote(input: GitLsRemoteInput): Promise<GitLsRemoteResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, LS_REMOTE_TIMEOUT_MS);
    const git = simpleGit({
      baseDir: tmpdir(),
      abort: controller.signal,
      timeout: { block: LS_REMOTE_TIMEOUT_MS, stdErr: false, stdOut: false },
      unsafe: buildUnsafe(input),
    });
    try {
      await git.env(buildChildEnv(input)).raw(['ls-remote', '--exit-code', input.url]);
      return { ok: true };
    } catch (e) {
      if (timedOut)
        return { ok: false, errorCode: 'TIMEOUT', message: 'connection timed out (15s)' };
      const raw = e instanceof Error ? e.message : String(e);
      return { ok: false, errorCode: classify(raw), message: sanitize(raw) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Test-connection taxonomy (03 §7.5 subset): permission matched before network. */
function classify(stderr: string): GitLsRemoteErrorCode {
  const s = stderr.toLowerCase();
  if (
    /authentication failed|authentication required|permission denied|could not read username|could not read password|unable to get password from user|access denied|invalid username or password|terminal prompts disabled|\b403\b|\b401\b|publickey|repository not found|\bnot found\b|\b404\b/.test(
      s,
    )
  ) {
    return 'CLONE_FAILED_PERMISSION';
  }
  return 'CLONE_FAILED_NETWORK';
}

/** Strip secrets before returning a message (03 §7.5 G — incl. Authorization lines). */
function sanitize(raw: string): string {
  let s = raw.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1');
  s = s
    .replace(/authorization:\s*\S+.*$/gim, 'Authorization: ***')
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, '***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***')
    .replace(/\bx-access-token:[^\s@]+/gi, 'x-access-token:***')
    .replace(/([?&](?:access_token|password|token)=)[^\s&]+/gi, '$1***');
  return s.replace(/\s+/g, ' ').trim().slice(0, 500);
}
