import type { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server, ServerOptions } from 'socket.io';
import { isRequestOriginAllowed } from './public-origin-policy';
import { DeploymentState } from '../platform/deployment/deployment-state';
import {
  readPublicNetworkConfig,
  type PublicNetworkConfig,
} from '../platform/config/public-network';

class OriginCheckedIoAdapter extends IoAdapter {
  private readonly deployment: DeploymentState;
  constructor(
    app: INestApplication,
    private readonly network: PublicNetworkConfig,
  ) {
    super(app);
    this.deployment = app.get(DeploymentState);
  }

  override createIOServer(port: number, options?: Partial<ServerOptions>): Server {
    const previousCheck = options?.allowRequest;
    const server: Server = super.createIOServer(port, {
      ...options,
      allowRequest: (req, done) => {
        if (this.deployment.draining) {
          done('Service is preparing an update', false);
          return;
        }
        if (!isRequestOriginAllowed(req, this.network)) {
          done('Origin is not allowed', false);
          return;
        }
        if (previousCheck) previousCheck(req, done);
        else done(null, true);
      },
    } satisfies Partial<ServerOptions>);
    const stopObserving = this.deployment.observeSockets(() => server.engine.clientsCount);
    server.engine.once('close', stopObserving);
    return server;
  }
}

/**
 * WS transport (docs/backend/06 §2): socket.io adapter for the /terminal (and
 * future /events) namespaces. Kept explicit so the adapter choice is visible and
 * swappable (e.g. to raw `ws`) behind the gateway abstraction.
 */
export function setupWebsockets(
  app: INestApplication,
  network: PublicNetworkConfig = readPublicNetworkConfig(),
): void {
  app.useWebSocketAdapter(new OriginCheckedIoAdapter(app, network));
}
