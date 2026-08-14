import { Inject, Injectable } from '@nestjs/common';
import type Docker from 'dockerode';
import { DockerSandboxProvider } from '../docker/docker-sandbox.provider';
import { DOCKER_CLIENT } from '../docker/docker.token';

/**
 * `boxlite` — micro-VM provider (docs/backend/04 §2.1). In S1 it is ALSO
 * docker-backed (same OCI image) and differs only by config/labels; the
 * independent-kernel micro-VM strong isolation is a later phase. Keeping both
 * providers registered from day one stress-tests the open ProviderId registry
 * (§2.3): two providers coexist and `CreateSandboxRequest.provider` selects.
 */
@Injectable()
export class BoxliteSandboxProvider extends DockerSandboxProvider {
  constructor(@Inject(DOCKER_CLIENT) docker: Docker) {
    super(docker, {
      name: 'boxlite',
      isolationLabel: 'micro-vm',
      keepAliveCmd: ['tail', '-f', '/dev/null'],
      capabilities: {
        spawnTty: true,
        volumeMount: true,
        updateResources: false,
        pauseResume: false,
        snapshot: false,
        watchEvents: true,
      },
    });
  }
}
