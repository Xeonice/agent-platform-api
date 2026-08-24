import { CredentialPreparationError } from '@platform/contracts';
import type { CredentialFacade, GitAuthContext } from '@platform/contracts';
import { RepoUrl } from '../domain/value-objects/repo-url.vo';

/**
 * Resolve a git-auth handle for a repo URL, or `null` to proceed anonymously
 * (docs/backend/03 §7.3, editorial boundary A).
 *
 * Shared by the CLONE workflow and the SYNC workflow because they must make the SAME
 * decision: both compute `kind`/`host`/`scheme` from the URL via `RepoUrl` and hand
 * only those enums across `CREDENTIAL_FACADE` — the project context never sees
 * plaintext, only an opaque handle it is obliged to `dispose()`.
 *
 * A missing credential (or a host outside the credential's `allowedHosts`) is NOT an
 * error here: public repos are a first-class case, and a private repo without a
 * credential must fail as a git PERMISSION error with git's own words, not as a
 * platform exception thrown before git ran.
 */
export async function prepareGitAuth(
  credentials: CredentialFacade,
  repoUrl: string,
): Promise<GitAuthContext | null> {
  let repo: RepoUrl;
  try {
    repo = RepoUrl.create(repoUrl);
  } catch {
    return null; // already validated at create time; be defensive
  }
  try {
    return await credentials.prepareGitAuth(repo.credentialKind(), repo.host(), repo.scheme());
  } catch (e) {
    if (e instanceof CredentialPreparationError) return null; // no cred / host not allowed
    throw e;
  }
}
