import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { Global, Module } from '@nestjs/common';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import { LoggingModule } from '../../../src/platform/logging/logging.module';
import { PlatformLoggerService } from '../../../src/platform/logging/platform-logger.service';
import {
  RUNTIME_LOG_READER,
  type RuntimeLogReader,
} from '../../../src/platform/logging/runtime-log-reader';

/**
 * `LoggingModule` 是**自包含**的:主会话把它加进 `app.module.ts` 的 imports、
 * 在 `main.ts` 里 `app.useLogger(...)` 就接完了(接入说明见交付报告)。
 * 这条测试盯的是那两步之前的东西 —— 模块本身能不能装起来、
 * `RUNTIME_LOG_READER` 拿不拿得到(并行的导出端点就靠它)。
 */

const fixedClock: Clock = { now: () => new Date('2026-08-27T00:00:00.000Z') };

/**
 * 生产上 `CLOCK` 由 `@Global()` 的 `PlatformModule` 提供 —— 被 import 进来的
 * `LoggingModule` 看得见的正是全局那一份。测试里必须同样用 `@Global()` 复现,
 * 把 provider 平铺在 root testing module 上是**看不见的**(它不是全局的),
 * 那样测出来的装配关系与生产不是同一个。
 */
@Global()
@Module({ providers: [{ provide: CLOCK, useValue: fixedClock }], exports: [CLOCK] })
class GlobalClockModule {}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'logging-module-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('LoggingModule.forRoot()', () => {
  it('装配后 PlatformLoggerService 与 RUNTIME_LOG_READER 都能取到,落盘可读回', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        GlobalClockModule,
        LoggingModule.forRoot({ dir, maxBytes: 1_000_000, maxFiles: 5 }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();

    const logger = app.get(PlatformLoggerService);
    logger.log('module wired', 'Bootstrap');

    // onApplicationShutdown 把 pending 与 stream 放干 —— 退出时不丢最后几行。
    await app.close();

    const reader = app.get<RuntimeLogReader>(RUNTIME_LOG_READER);
    const stream = reader.read({ maxBytes: 1_000_000 });
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const c of stream!) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString('utf8')).toContain('module wired');

    expect(existsSync(join(dir, 'runtime.log'))).toBe(true);
  });
});
