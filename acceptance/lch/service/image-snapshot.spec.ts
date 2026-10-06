import { describe, expect, it } from 'vitest';
import { seedImageManifest } from '../../support/sqlite';
import type { TaskImageSelection } from '@platform/contracts';
import { harness, waitForStatus } from '../../support/sandbox-rig';

describe('task image snapshot through create, detail, list, and restart', () => {
  it('retains its version row and digest when the same coordinate moves to a new version', async () => {
    const h = harness();
    const ref = 'docker.io/acme/ml-agent:v1.0';
    const original = await h.imageFacade.resolveForTask(ref, h.provider.name);
    const versions = new Map<string, TaskImageSelection>();
    let current = { ...original, manifestId: 'version-one', digest: `sha256:${'1'.repeat(64)}` };
    versions.set(current.manifestId, current);
    seedImageManifest(h.sqlite, {
      manifestId: current.manifestId,
      name: current.ref,
      digest: current.digest,
    });
    h.imageFacade.resolveForTask = async () => current;
    h.imageFacade.findTaskImage = async (id) => versions.get(id) ?? null;
    h.imageFacade.findTaskImageSummary = async (id) => {
      const image = versions.get(id);
      return image
        ? {
            manifestId: id,
            ref: image.ref,
            digest: image.digest,
            isBuiltin: false,
            isActive: true,
            validationStatus: 'valid',
          }
        : null;
    };
    const first = await h.service.create({
      projectId: 'prj-1',
      runtime: 'claude-code',
      image: ref,
    });
    const snapshot = {
      image: ref,
      imageId: 'version-one',
      imageDigest: current.digest,
      imageIsBuiltin: false,
    };
    expect(first).toMatchObject(snapshot);
    await waitForStatus(h.service, first.id, 'running');
    current = { ...current, manifestId: 'version-two', digest: `sha256:${'2'.repeat(64)}` };
    versions.set(current.manifestId, current);
    seedImageManifest(h.sqlite, {
      manifestId: current.manifestId,
      name: current.ref,
      digest: current.digest,
    });
    const second = await h.service.create({
      projectId: 'prj-1',
      runtime: 'claude-code',
      image: ref,
    });
    expect(second).toMatchObject({ imageId: 'version-two', imageDigest: current.digest });
    expect(await h.service.get(first.id)).toMatchObject(snapshot);
    expect((await h.service.list()).find((task) => task.id === first.id)).toMatchObject(snapshot);
    await h.service.stop(first.id);
    expect(await h.service.start(first.id)).toMatchObject({
      ...snapshot,
      status: 'starting',
      hasRun: true,
    });
    await Promise.all([first, second].map((task) => waitForStatus(h.service, task.id, 'running')));
    expect(await h.service.get(first.id)).toMatchObject(snapshot);
  });
});
