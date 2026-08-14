import type { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';

/**
 * WS transport (docs/backend/06 §2): socket.io adapter for the /terminal (and
 * future /events) namespaces. Kept explicit so the adapter choice is visible and
 * swappable (e.g. to raw `ws`) behind the gateway abstraction.
 */
export function setupWebsockets(app: INestApplication): void {
  app.useWebSocketAdapter(new IoAdapter(app));
}
