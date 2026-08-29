import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupSwagger } from './bootstrap/swagger.setup';
import { configurePlatformApp } from './bootstrap/configure-app';
import { setupWebsockets } from './bootstrap/websocket.setup';
import { describeBindExposure, env } from './platform/config/env';
import { PlatformLoggerService } from './platform/logging';

async function bootstrap(): Promise<void> {
  // production entrypoint opts into startup orphan reconciliation (13 §4); tests
  // (which boot throwaway apps on fresh :memory: DBs) leave it off by default.
  process.env.SANDBOX_RECONCILE_ON_BOOT ??= 'true';

  // bufferLogs: 启动期的日志先缓存,等落盘 logger 就位后一次冲出来——否则
  // ${DATA_ROOT}/logs/ 里永远缺失最早那几行,而那几行正是启动失败时要看的。
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PlatformLoggerService));

  // 三样全局装配收在一处，**e2e 用的是同一个函数**（见那里的长注释）。
  configurePlatformApp(app);

  setupWebsockets(app);
  setupSwagger(app);

  // 绑在通配地址时的那条提示 —— 判定在 `describeBindExposure`（纯函数，单测在
  // `apps/api/test/unit/config/bind-exposure.spec.ts`）。compose 形态下它必然为真而
  // 又不代表出错，所以那里要的是一句**显式声明**，不是一次探测。
  const exposure = describeBindExposure(env.host, process.env.HTTP_BIND_GATED_BY);
  if (exposure.level === 'warn') Logger.warn(exposure.message, 'Bootstrap');
  else if (exposure.level === 'declared') Logger.log(exposure.message, 'Bootstrap');

  // SIGTERM 时走 onApplicationShutdown 放干缓冲,否则退出会丢最后几行(11 §1.2.1)。
  app.enableShutdownHooks();

  await app.listen(env.port, env.host);
  Logger.log(`API listening on http://${env.host}:${env.port} (prefix /api)`, 'Bootstrap');
}

void bootstrap();
