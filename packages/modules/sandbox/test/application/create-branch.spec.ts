import { describe, it, expect } from 'vitest';
import { harness, waitForStatus } from './_harness';

/**
 * 建 Task 时选分支 — the WIRING half (docs/backend/03 §7.2★, 10 §7.3
 * `CreateSandboxRequest.branch`).
 *
 * `create-door.spec.ts` pins what happens when the branch is REFUSED; this file pins
 * that the value survives the three hand-offs between the wire and the checkout —
 * door → `AdmittedCreate` → `ProvisionSandboxWorkflow` → `WorkspacePreparer`. Every one
 * of them was a place the field could be dropped without a single test noticing:
 * `admit` returned a bare `baselinePath`, and `runSafely` took a bare string. A
 * sandbox that silently starts on the default branch is the failure mode — it does not
 * error, it just runs the agent against the wrong code.
 *
 * MUTATION: drop `branch` from the object `admit` returns (or from the `prepare` call
 * in the provision workflow) and the first test goes red while everything else — the
 * door, the DTO, the status machine — stays green.
 */
describe('CreateSandbox.branch reaches the workspace preparer', () => {
  it('a requested branch is validated at the door AND handed to prepare()', async () => {
    const h = harness();
    const dto = await h.service.create({
      projectId: 'prj-1',
      runtime: 'claude-code',
      branch: 'feature/x',
    });
    await waitForStatus(h.service, dto.id, 'running');

    // ① the door asked the project context about THIS branch — not about no branch.
    //    Without this, a facade that validates perfectly would never be told what to
    //    validate, and every branch would be accepted.
    expect(h.branchesAsked).toEqual(['feature/x']);
    // ② …and the value reached the one place that can act on it.
    expect(h.wsSources).toEqual([{ baselinePath: '/tmp/baseline/prj-1', branch: 'feature/x' }]);
  });

  it('no branch requested ⇒ prepare() is told none, and nothing invents a default', async () => {
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');

    expect(h.branchesAsked).toEqual([undefined]);
    // `undefined` and NOT `'main'`: the platform must not guess a default branch name.
    // The baseline already has one checked out (whatever the remote's HEAD was), and
    // hard-coding `main` would break every repo still on `master` — invisibly, by
    // failing the checkout of a branch that does not exist.
    expect(h.wsSources).toEqual([{ baselinePath: '/tmp/baseline/prj-1', branch: undefined }]);
  });
});
