import { ConsoleLogger, Inject, Injectable, type LoggerService } from '@nestjs/common';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import { redactLogLine } from './log-redactor';
import { RuntimeLogWriter } from './runtime-log-writer';
import { RUNTIME_LOG_WRITER } from './logging.tokens';

/** 与 Nest `LogLevel` 对齐的落盘标签（定宽，方便 `grep` 与肉眼扫）。 */
const LEVEL_LABEL = {
  log: 'LOG    ',
  error: 'ERROR  ',
  warn: 'WARN   ',
  debug: 'DEBUG  ',
  verbose: 'VERBOSE',
  fatal: 'FATAL  ',
} as const;

type Level = keyof typeof LEVEL_LABEL;

/**
 * 平台 `LoggerService` —— **落盘 + stdout 并存**。
 *
 * ⚠️ 落盘**不替代** stdout（shared/11 §1.2.1）：容器化部署下 `docker compose logs`
 * 是运维的第一反应,砍掉 stdout 等于把最常用的那条路堵死。落盘存在的理由是**平台
 * 自己要能读到日志**才能提供 [导出日志](P21-5 §10.3) —— 靠 `docker logs` 不行:
 * 平台不一定在容器里(boxlite 档位可裸跑),在容器里也得挂 docker socket + 知道自己
 * 的容器 id,绕且脆。
 *
 * ⚠️ 脱敏在**写入口**,并且两条出口用的是**同一份已脱敏文本**(05 §4 / P21-5 §10.5)。
 * 不在读出口脱敏:明文一旦落盘,导出、备份、直接读文件三条路都漏。
 *
 * 时间取自 `Clock` 端口 —— 全仓禁 `new Date()` / `Date.now()`(01 §3 / 25 §1.4),
 * 这样落盘行的时间戳在测试里可钉死。
 */
@Injectable()
export class PlatformLoggerService implements LoggerService {
  private readonly console = new ConsoleLogger();

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RUNTIME_LOG_WRITER) private readonly writer: RuntimeLogWriter,
  ) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('log', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('fatal', message, optionalParams);
  }

  private emit(level: Level, message: unknown, optionalParams: unknown[]): void {
    const { context, rest } = splitContext(optionalParams);
    const raw = [format(message), ...rest.map(format)].filter((s) => s.length > 0).join(' ');
    // ★ 唯一一次脱敏,两条出口共用结果 —— 分别脱敏就会分别漏。
    const redacted = redactLogLine(raw);

    const stamp = this.clock.now().toISOString();
    const tag = context ? `[${context}] ` : '';
    this.writer.write(`${stamp} ${LEVEL_LABEL[level]} ${tag}${redacted}`);

    // stdout 走 Nest 自带 ConsoleLogger,保持运维熟悉的那套着色与格式。
    if (context) this.console[level](redacted, context);
    else this.console[level](redacted);
  }
}

/** Nest 的惯例:最后一个 string 参数是 context。 */
function splitContext(params: unknown[]): { context?: string; rest: unknown[] } {
  if (params.length > 0 && typeof params[params.length - 1] === 'string') {
    return { context: params[params.length - 1] as string, rest: params.slice(0, -1) };
  }
  return { rest: params };
}

function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }
  return String(value);
}
