import { describe, it, expect } from 'vitest';
import { AioWsProcessStream } from '../../src/infrastructure/providers/aio/aio-sandbox-agent.client';

/** 最小 WS 替身：只需要 addEventListener + close，close 时按真实语义触发 'close'。 */
function fakeWs() {
  const listeners: Record<string, ((e?: unknown) => void)[]> = {};
  return {
    addEventListener: (t: string, cb: (e?: unknown) => void) => {
      (listeners[t] ??= []).push(cb);
    },
    send: () => undefined,
    close: () => {
      // 真实 WebSocket：本端主动 close() 之后 'close' 事件照样会触发。
      for (const cb of listeners['close'] ?? []) cb();
    },
  };
}

// 后端 review 抓到的：`detach()` 的注释写着"这里不 synthExit",而构造函数把 ws 的
// `'close'`/`'error'` 都接到了 `synthExit` —— 本端主动 close() 之后 'close' 照样触发，
// 于是"松手"被间接报成了"退出"。docker exec fallback 那条路同理（`end()` → `'end'`
// → `reportExit`，而它连幂等锁都没有）。
//
// 判据是**上层收到了什么**，不是"detach 方法体里有没有写 synthExit" —— 后者正是
// 那句假注释成立的方式。
describe('detach() 不得让上层以为进程退出了', () => {
  it('detach 之后 onExit 不该被触发', () => {
    const ws = fakeWs();
    const s = new AioWsProcessStream(ws as never);
    let exits = 0;
    s.onExit(() => {
      exits += 1;
    });
    s.detach();
    expect(exits).toBe(0);
  });
});
