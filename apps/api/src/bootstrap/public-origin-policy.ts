import { ForbiddenException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { CorsOptionsCallback } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { IncomingMessage } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import { parseHttpOrigin, type PublicNetworkConfig } from '../platform/config/public-network';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Same policy for HTTP and Engine.IO's actual transport handshake, including websocket. */
export function isRequestOriginAllowed(req: IncomingMessage, config: PublicNetworkConfig): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // Authenticated CLI/MCP clients need not send Origin.
  const parsed = parseHttpOrigin(origin);
  if (!parsed || parsed !== origin) return false;
  if (config.allowedOrigins.length > 0) return config.allowedOrigins.includes(parsed);
  // No proxy headers here. A public TLS proxy must explicitly declare its allowed origins.
  const secure = 'encrypted' in req.socket && req.socket.encrypted === true;
  if (parsed === `${secure ? 'https' : 'http'}://${req.headers.host ?? ''}`) return true;
  // Next's local rewrite changes Host to the API port while retaining the browser's
  // web Origin. This default is limited to a real local peer and literal local origins.
  // A configured public allowlist above never falls back to this development rule.
  const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  const localPeer = peer === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(peer ?? '');
  return localPeer && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(parsed).hostname);
}

export function configurePublicHttp(app: INestApplication, config: PublicNetworkConfig): void {
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.headers.origin !== undefined) res.vary('Origin');
    const browserWithoutOrigin =
      !SAFE_METHODS.has(req.method) &&
      req.headers.origin === undefined &&
      req.headers['sec-fetch-site'] !== undefined;
    if (!isRequestOriginAllowed(req, config) || browserWithoutOrigin) {
      next(
        new ForbiddenException({
          code: 'FORBIDDEN',
          message: '请求来源不在允许列表中',
          retryable: false,
          sideEffectFree: true,
        }),
      );
      return;
    }
    next();
  });
  app.enableCors((req: Request, callback: CorsOptionsCallback) => {
    callback(null, {
      origin: req.headers.origin ?? false,
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Access-Passcode', 'X-Schema-Hash'],
      exposedHeaders: ['X-Schema-Hash', 'Content-Disposition', 'Content-Length'],
      maxAge: 600,
    });
  });
}
