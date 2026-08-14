import { Inject, Injectable } from '@nestjs/common';
import type Docker from 'dockerode';
import { DockerSandboxProvider } from '../docker/docker-sandbox.provider';
import { DOCKER_CLIENT } from '../docker/docker.token';

/**
 * `aio` — default provider (docs/backend/04 §2.1). Container-level isolation.
 * In S1 it is docker-backed like boxlite; it reuses the platform default OCI
 * image (AIO Sandbox in production).
 */
@Injectable()
export class AioSandboxProvider extends DockerSandboxProvider {
  constructor(@Inject(DOCKER_CLIENT) docker: Docker) {
    super(docker, {
      name: 'aio',
      isolationLabel: 'container',
      keepAliveCmd: ['tail', '-f', '/dev/null'],
      capabilities: {
        spawnTty: true,
        volumeMount: true,
        updateResources: true,
        pauseResume: true,
        snapshot: false,
        watchEvents: true,
      },
    });
  }
}
