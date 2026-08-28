import { describe, it, expect } from 'vitest';
import { redactLogLine } from '../../../src/platform/logging/log-redactor';
import {
  redactClaude,
  redactCodex,
} from '../../../../../packages/modules/runtime/src/domain/services/secret-redactor';

/**
 * 05 §4「日志脱敏」+ P21-5 §10.5「脱敏发生在写入口而非导出时」。
 *
 * MUTATION 验证:把 `platform-logger.service.ts` 里 `redactLogLine(raw)` 换成 `raw`
 * ⇒ platform-logger.service.spec.ts 的落盘断言红(见那边)。本文件测规则本身。
 */

const CLAUDE_OAUTH = 'sk-ant-oat01-AbCdEf0123456789_-XyZ';
const CLAUDE_API = 'sk-ant-api03-0123456789abcdefgh';
const OPENAI = 'sk-0123456789abcdefghij';
const GH_PAT = 'ghp_0123456789abcdefghijklmnopqrstuv';

describe('redactLogLine —— 写入口脱敏', () => {
  it('claude OAuth token 被遮,前缀保留(便于认出「这里有过一个 token」)', () => {
    const out = redactLogLine(`launching with ${CLAUDE_OAUTH} ok`);
    expect(out).not.toContain(CLAUDE_OAUTH);
    expect(out).toContain('sk-ant-oat01-***');
  });

  it('折行分片:先各自打码再拼接,拼起来也不是密钥', () => {
    // 05 §4 P1-4b:「分片各自不像密钥、拼起来才是」的漏网必须被前缀规则挡住。
    const head = redactLogLine('sk-ant-oat01-AbCdEf');
    const tail = redactLogLine('0123456789XyZ');
    expect(`${head}${tail}`).not.toContain(CLAUDE_OAUTH);
  });

  it('sk-ant / sk- / ghp_ 三个家族都遮', () => {
    const out = redactLogLine(`${CLAUDE_API} ${OPENAI} ${GH_PAT}`);
    expect(out).not.toContain(CLAUDE_API);
    expect(out).not.toContain(OPENAI);
    expect(out).not.toContain(GH_PAT);
    expect(out).toContain('ghp_***');
  });

  it('JSON 报文里的 token 字段被遮(auth.json / 刷新回写整份被打出来的那种)', () => {
    const out = redactLogLine('{"access_token":"eyJhbGc.abc","refresh_token":"rt-secret-value"}');
    expect(out).not.toContain('eyJhbGc.abc');
    expect(out).not.toContain('rt-secret-value');
    expect(out).toContain('"access_token":"***"');
  });

  it('授权 URL 的 state / code 参数不入日志(05 §4)', () => {
    const out = redactLogLine('open https://auth.example.com/cb?state=Zm9vYmFy&code=deadbeef now');
    expect(out).not.toContain('Zm9vYmFy');
    expect(out).not.toContain('deadbeef');
    expect(out).toContain('state=***');
  });

  it('Authorization 头被遮', () => {
    const out = redactLogLine('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
    expect(out).not.toContain('payload.sig');
  });

  it('codex 的 device-code 是给用户看的非密钥 —— 必须**保持可读**', () => {
    // 05 §4:codex device-code(`XXXX-XXXXX`)可显示。遮掉它 = 用户没法完成登录。
    const out = redactLogLine('enter code WDJB-MJHT at https://example.com/device');
    expect(out).toContain('WDJB-MJHT');
    expect(out).toContain('https://example.com/device');
  });

  it('无密钥的普通行原样通过(过度脱敏会把栈和路径吃掉,那是运行日志的全部价值)', () => {
    const line = 'GET /api/sandboxes 200 in 12ms — workspace /srv/data/workspaces/sbx-1';
    expect(redactLogLine(line)).toBe(line);
  });
});

/**
 * ── 与 runtime 侧脱敏器的**对账** ────────────────────────────────────────────
 * `log-redactor.ts` 复述了 `runtime/domain/services/secret-redactor.ts` 的规则
 * (够不着它,理由见那边的注释)。**复述就会漂**,所以这里逐样本对账:
 * 凡 runtime 侧任一 profile 会改写的样本,本函数必须也改写,且原文不得残留。
 */
describe('与 05 §4 的 per-CLI 脱敏器同源(对账)', () => {
  const corpus = [
    `token=${CLAUDE_OAUTH}`,
    `key ${CLAUDE_API}`,
    `openai ${OPENAI}`,
    '{"refresh_token":"rt-abc-123456"}',
    '{"id_token":"jwt-abc-123456"}',
  ];

  for (const sample of corpus) {
    it(`runtime 侧会遮的,这边也遮:${sample.slice(0, 32)}…`, () => {
      const runtimeMasked = redactClaude(sample) !== sample || redactCodex(sample) !== sample;
      expect(runtimeMasked, '样本选错了 —— runtime 侧根本不遮它').toBe(true);
      expect(redactLogLine(sample)).not.toBe(sample);
    });
  }

  it('device-code 两边都不遮(同源也包括「同样不遮什么」)', () => {
    const sample = 'device code WDJB-MJHT';
    expect(redactCodex(sample)).toBe(sample);
    expect(redactLogLine(sample)).toBe(sample);
  });
});
