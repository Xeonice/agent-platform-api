import { describe, it, expect, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { ErrorEnvelopeFilter } from '../../src/bootstrap/error-envelope.filter';

/**
 * 10 §6.8 写着「所有非 2xx 响应一律是这个形状，**无例外**」——在这个 filter 之前
 * 那句话不成立：26 处裸 Nest 异常出线的是 `{message,error,statusCode}`，
 * 前端 `isErrorEnvelope` 判定失败后整条替换成「请求失败（HTTP 404）」，
 * 后端那句指名道姓的话就此丢掉。
 *
 * MUTATION：把 `useGlobalFilters(new ErrorEnvelopeFilter())` 从 main.ts 拿掉 ⇒
 * e2e 侧的形状断言红；本文件的单测直接测 filter，覆盖每一条归一路径。
 */
/**
 * 最小 ArgumentsHost 替身。用 `Pick` 声明**只用到的那几个成员**，
 * 而不是 `as unknown as ArgumentsHost` —— 后者在本仓是被 lint 禁掉的
 * （"用正当类型收窄替代"），且它会让替身与真实接口的偏差静默通过。
 */
type MinimalHost = Pick<ArgumentsHost, 'getType' | 'switchToHttp'>;

function hostWith(): { host: MinimalHost; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const res = { status: vi.fn(() => ({ json })) };
  const host: MinimalHost = {
    getType: <TContext extends string = string>(): TContext => 'http' as TContext,
    switchToHttp: () =>
      ({
        getResponse: () => res,
        getRequest: () => ({ method: 'GET', url: '/api/x' }),
      }) as ReturnType<ArgumentsHost['switchToHttp']>,
  };
  return { host, json };
}

function run(exception: unknown): Record<string, unknown> {
  const { host, json } = hostWith();
  new ErrorEnvelopeFilter().catch(exception, host as ArgumentsHost);
  expect(json).toHaveBeenCalledTimes(1);
  return json.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe('ErrorEnvelopeFilter — 四种入参归一成同一形状', () => {
  it('① 已是完整信封 ⇒ 原样放行（门口拒绝自己知道 sideEffectFree，filter 不插手）', () => {
    const door = new HttpException(
      {
        code: 'BRANCH_NOT_FOUND',
        message: "project p has no branch 'x'",
        retryable: false,
        sideEffectFree: true,
      },
      HttpStatus.BAD_REQUEST,
    );
    const out = run(door);
    expect(out['code']).toBe('BRANCH_NOT_FOUND');
    expect(out['retryable']).toBe(false);
    // ⚠️ 这一位必须原样带出：它是「零副作用」与「已受理后失败」的唯一区分，
    // 丢了就会给一个本该"就地改配置"的拒绝配上 [重试]。
    expect(out['sideEffectFree']).toBe(true);
  });

  it('② 半个信封 {code,message} ⇒ 补 retryable，不动 code/message', () => {
    const partial = new HttpException(
      { code: 'INVALID_ARTIFACT_NAME', message: "'../x' is not a valid artifact name" },
      HttpStatus.BAD_REQUEST,
    );
    const out = run(partial);
    expect(out['code']).toBe('INVALID_ARTIFACT_NAME');
    expect(out['retryable']).toBe(false); // 4xx 默认不可重试
    expect(out['sideEffectFree']).toBeUndefined(); // 传输层不猜这一位
  });

  it("⭐ ②' 只有 code、没有 message ⇒ **code 必须活着出线**（口令门就是这个形状）", () => {
    // ⚠️ 这条抓的是一个真的把第一道门变成哑巴的缺陷。口令门四处抛的是
    //    `{ code: 'PASSCODE_LOCKED', retryAfterSec }`——有 code、没有 message。
    //    ① 要三位俱全、② 要 code+message，两边都不匹配 ⇒ 落到 ③「裸 Nest」⇒
    //    `codeForStatus(429)` 打回 `BAD_REQUEST`，message 退回 Nest 的 `'Http Exception'`。
    //    用户在解锁页上看到的就是那四个字，而 HTTP 明明是 429。
    //
    // MUTATION: 删掉 filter 里的 ②' 分支 ⇒ code 变 `BAD_REQUEST`，本条红。
    const locked = new HttpException(
      { code: 'PASSCODE_LOCKED', retryAfterSec: 287 },
      HttpStatus.TOO_MANY_REQUESTS,
    );
    const out = run(locked);
    expect(out['code']).toBe('PASSCODE_LOCKED');
    // ⚠️ 随行字段也要活着：没有 `retryAfterSec`，「可重试」就退化成让用户盲目重试，
    //    而每次重试只是再撞一次同一把锁。
    expect(out['retryAfterSec']).toBe(287);
    expect(out['retryable']).toBe(true); // 429 说的正是「稍后再来」
  });

  it("②' body 自己给了 retryable ⇒ 用 body 的，不用状态码猜的", () => {
    // 428 在 `defaultRetryable` 里会算成不可重试（4xx），但抛出点说 true 就是 true——
    // 显式值一律优先，这是 filter 全篇的规矩（见 `defaultRetryable` 的注释）。
    // MUTATION: ②' 里改成无条件 `defaultRetryable(status)` ⇒ 本条红。
    const out = run(
      new HttpException({ code: 'SOMETHING', retryable: true }, HttpStatus.PRECONDITION_REQUIRED),
    );
    expect(out['code']).toBe('SOMETHING');
    expect(out['retryable']).toBe(true);
  });

  it('③ 裸 Nest 异常 ⇒ 给码，且**message 必须透传**', () => {
    const out = run(new NotFoundException('sandbox nope not found'));
    expect(out['code']).toBe('NOT_FOUND');
    expect(out['retryable']).toBe(false);
    // 这句话是唯一说清"到底哪儿不对"的东西。此前它被前端替换成
    // 「请求失败（HTTP 404）」——本条就是钉住"别再丢掉它"。
    expect(out['message']).toBe('sandbox nope not found');
  });

  it('③b 409 ⇒ INVALID_STATE（C 类：请求没错，此刻不行）', () => {
    const out = run(new ConflictException('sync is only allowed on a ready project'));
    expect(out['code']).toBe('INVALID_STATE');
    expect(out['message']).toBe('sync is only allowed on a ready project');
    expect(out['retryable']).toBe(false);
  });

  it('④ 未捕获的非 HttpException ⇒ INTERNAL，且**不透传内部细节**', () => {
    const out = run(new Error('SELECT * FROM sandboxes WHERE secret=... at /srv/app/db.ts:42'));
    expect(out['code']).toBe('INTERNAL');
    expect(out['retryable']).toBe(true);
    // 路径/SQL/栈一律不出线，真正的信息进日志按 traceId 记。
    expect(String(out['message'])).not.toContain('SELECT');
    expect(String(out['message'])).not.toContain('/srv/app');
  });

  it('traceId 一定有 —— 10 §6.8 说它是"用户报障时报的那个"，而此前一个响应都没带过', () => {
    const out = run(new NotFoundException('x'));
    expect(typeof out['traceId']).toBe('string');
    expect(String(out['traceId']).length).toBeGreaterThan(0);
  });

  it('408/429 是 4xx 里的例外：它们说的正是"稍后再来"', () => {
    expect(run(new HttpException('slow', HttpStatus.REQUEST_TIMEOUT))['retryable']).toBe(true);
    expect(run(new HttpException('busy', HttpStatus.TOO_MANY_REQUESTS))['retryable']).toBe(true);
    expect(run(new BadRequestException('bad'))['retryable']).toBe(false);
  });
});
