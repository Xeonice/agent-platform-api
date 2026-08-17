import { Inject, Injectable } from '@nestjs/common';
import type Docker from 'dockerode';
import { DockerContainerBackend } from '../docker/docker-container-backend';
import { DOCKER_CLIENT } from '../docker/docker.token';

/**
 * `aio` — default provider (docs/backend/04 §2.1, SANDBOX-RUNTIME-DECISIONS 决策
 * A/B). Container-level isolation via dockerode (control plane); exec/pty go
 * through the in-sandbox AIO Sandbox agent on `:8080` (data plane), NOT host
 * docker exec. The AIO image ships its own entrypoint that starts the agent, so
 * NO keep-alive command is set. The agent port is published to loopback only.
 */
@Injectable()
export class AioSandboxProvider extends DockerContainerBackend {
  constructor(@Inject(DOCKER_CLIENT) docker: Docker) {
    super(docker, {
      name: 'aio',
      isolationLabel: 'container',
      agentPort: 8080,
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
