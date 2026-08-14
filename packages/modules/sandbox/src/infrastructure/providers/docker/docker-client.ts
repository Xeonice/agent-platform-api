import Docker from 'dockerode';

/**
 * Build a dockerode client from DOCKER_HOST (docs/shared/11 §1: in production this
 * points at the docker-socket-proxy, e.g. tcp://docker-proxy:2375, which only
 * whitelists CONTAINERS/EXEC/IMAGES). Falls back to the local unix socket.
 */
export function createDockerClient(): Docker {
  const host = process.env.DOCKER_HOST;
  if (host && host.startsWith('tcp://')) {
    const url = new URL(host);
    return new Docker({ host: url.hostname, port: Number(url.port || 2375) });
  }
  if (host && host.startsWith('unix://')) {
    return new Docker({ socketPath: host.replace('unix://', '') });
  }
  return new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });
}

/** Is a docker daemon reachable? Used to SKIP the docker-required e2e (never fake-pass). */
export async function isDockerAvailable(client: Docker): Promise<boolean> {
  try {
    await client.ping();
    return true;
  } catch {
    return false;
  }
}
