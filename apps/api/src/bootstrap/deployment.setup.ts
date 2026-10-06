import { ServiceUnavailableException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { DeploymentState } from '../platform/deployment/deployment-state';

export function configureDeploymentBarrier(app: INestApplication): void {
  const state = app.get(DeploymentState);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (state.draining && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      next(
        new ServiceUnavailableException({
          code: 'UPSTREAM_UNAVAILABLE',
          message: '服务正在准备更新，请稍后重试',
          retryable: true,
          sideEffectFree: true,
        }),
      );
      return;
    }
    if (req.method !== 'GET' || !['/api/health', '/api/deployment/status'].includes(req.path)) {
      const end = state.beginRequest();
      res.once('finish', end);
      res.once('close', end);
    }
    next();
  });
}
