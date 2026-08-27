import { Global, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { resolve } from 'node:path';
import { env } from '../config/env';
import { PlatformLoggerService } from './platform-logger.service';
import { RUNTIME_LOG_WRITER } from './logging.tokens';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  RuntimeLogWriter,
  type RuntimeLogWriterOptions,
} from './runtime-log-writer';
import { FileRuntimeLogReader, RUNTIME_LOG_READER } from './runtime-log-reader';

export type LoggingModuleOptions = Partial<RuntimeLogWriterOptions>;

/** 收流器:`app.close()` 时把在途轮转与 `pending` 放干,避免退出时丢最后几行。 */
@Injectable()
class RuntimeLogLifecycle implements OnApplicationShutdown {
  constructor(@Inject(RUNTIME_LOG_WRITER) private readonly writer: RuntimeLogWriter) {}

  async onApplicationShutdown(): Promise<void> {
    await this.writer.close();
  }
}

/**
 * 运行日志落盘模块 —— **自包含**,不改任何共享装配文件。
 *
 * 提供三样:
 *   - `PlatformLoggerService` —— Nest `LoggerService` 实现(落盘 + stdout 并存)
 *   - `RUNTIME_LOG_READER`   —— 给审计导出端点消费的只读出口(形状见 runtime-log-reader.ts)
 *   - `RUNTIME_LOG_WRITER`   —— 落盘 writer 本体,一般只有上面两位用
 *
 * `@Global()` 是**有意**的:导出端点、诊断端点都会用到 `RUNTIME_LOG_READER`,
 * 而它们分属不同 module。日志是横切设施,与 `PlatformModule` 同一档待遇。
 *
 * 默认落点 `${DATA_ROOT}/logs`(shared/11 §1.2.1 表:与 DB、工作区同一个数据根,
 * 备份/迁移一次带走)。`forRoot()` 的入参只给测试与将来的 ops 调参用;
 * 20MB × 5 份这两个初值目前是常量,等 `platform/config` 那片 zod 配置落地后
 * 再挪进 `env.ts`(不在本切片里加散装 `process.env` 读法 —— 那正是
 * `SANDBOX_DEFAULT_IMAGE` 分裂成两个兜底值的来路)。
 */
@Global()
@Module({})
export class LoggingModule {
  static forRoot(options: LoggingModuleOptions = {}): DynamicModule {
    const writerOptions: RuntimeLogWriterOptions = {
      dir: options.dir ?? resolve(env.dataRoot, 'logs'),
      baseName: options.baseName ?? 'runtime',
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    };
    return {
      module: LoggingModule,
      providers: [
        { provide: RUNTIME_LOG_WRITER, useFactory: () => new RuntimeLogWriter(writerOptions) },
        {
          provide: RUNTIME_LOG_READER,
          useFactory: (writer: RuntimeLogWriter) => new FileRuntimeLogReader(writer),
          inject: [RUNTIME_LOG_WRITER],
        },
        PlatformLoggerService,
        RuntimeLogLifecycle,
      ],
      exports: [RUNTIME_LOG_WRITER, RUNTIME_LOG_READER, PlatformLoggerService],
    };
  }
}
