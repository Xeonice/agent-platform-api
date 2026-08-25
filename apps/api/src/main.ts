import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupSwagger } from './bootstrap/swagger.setup';
import { platformValidationPipe } from './bootstrap/validation.pipe';
import { ErrorEnvelopeFilter } from './bootstrap/error-envelope.filter';
import { setupWebsockets } from './bootstrap/websocket.setup';
import { env, isExposedBind } from './platform/config/env';

async function bootstrap(): Promise<void> {
  // production entrypoint opts into startup orphan reconciliation (13 §4); tests
  // (which boot throwaway apps on fresh :memory: DBs) leave it off by default.
  process.env.SANDBOX_RECONCILE_ON_BOOT ??= 'true';

  const app = await NestFactory.create(AppModule);

  // /api prefix so REST paths and openapi.json paths carry it (02 §8).
  app.setGlobalPrefix('api');
  // zod single source validation for every createZodDto DTO (02 §3); failures come
  // out as a real ErrorEnvelope (04 §4) — see bootstrap/validation.pipe.ts.
  app.useGlobalPipes(platformValidationPipe());
  // 10 §6.8 写着「所有非 2xx 响应一律是这个形状，**无例外**」——在此之前那句话不成立：
  // 26 处裸 Nest 异常出线的是 `{message,error,statusCode}`，前端认不出信封就把
  // 后端说的话整条替换成「请求失败（HTTP 404）」。这个 filter 是那句话的兑现（10A）。
  app.useGlobalFilters(new ErrorEnvelopeFilter());

  setupWebsockets(app);
  setupSwagger(app);

  if (isExposedBind(env.host)) {
    Logger.warn(
      `HTTP is bound to ${env.host} — this instance may be reachable from the LAN/public. ` +
        `It holds user runtime credentials; prefer 127.0.0.1 + reverse proxy (shared/11 §3).`,
      'Bootstrap',
    );
  }

  await app.listen(env.port, env.host);
  Logger.log(`API listening on http://${env.host}:${env.port} (prefix /api)`, 'Bootstrap');
}

void bootstrap();
