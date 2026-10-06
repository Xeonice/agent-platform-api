import { Inject, Injectable, Optional } from '@nestjs/common';
import { createInterface } from 'node:readline';
import { RUNTIME_LOG_READER, type RuntimeLogReader } from '../logging';

const LOG_READ_LIMIT_BYTES = 1024 * 1024;
const PROVIDER_LOG_LINES = 20;
export interface ProviderLogResult {
  lines: string[];
  unavailableReason?: string;
}

/** 只读已脱敏运行日志，不开 provider 会话、不写审计；无可归属日志时如实说明。 */
@Injectable()
export class ProviderLogService {
  constructor(@Optional() @Inject(RUNTIME_LOG_READER) private readonly reader?: RuntimeLogReader) {}

  async read(providerId: string): Promise<ProviderLogResult> {
    if (this.reader === undefined) return { lines: [], unavailableReason: '运行日志设施未启用。' };
    try {
      const stream = this.reader.read({ maxBytes: LOG_READ_LIMIT_BYTES });
      if (stream === null) return { lines: [], unavailableReason: '尚未写入运行日志。' };
      const lines: string[] = [];
      const input = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of input) {
          if (!belongsToProvider(line, providerId)) continue;
          lines.push(line);
          if (lines.length > PROVIDER_LOG_LINES) lines.shift();
        }
      } finally {
        input.close();
      }
      return lines.length === 0
        ? { lines, unavailableReason: '最近的运行日志中没有该沙箱环境的记录。' }
        : { lines };
    } catch {
      return { lines: [], unavailableReason: '运行日志读取失败，请重试。' };
    }
  }
}

/** 仅认明确标注的来源，不把整个系统的相似词日志归给某个环境。 */
export function belongsToProvider(line: string, providerId: string): boolean {
  if (providerId === '') return false;
  const safe = providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const context = new RegExp(`\\[${safe}(?:Sandbox)?Provider\\]`, 'i');
  const explicit = new RegExp(
    `(?:\\[${safe}\\]|"provider(?:Id)?"\\s*:\\s*"${safe}"|\\bprovider(?:Id)?\\s*[:=]\\s*${safe}(?=[\\s,;]|$))`,
    'i',
  );
  return context.test(line) || explicit.test(line);
}
