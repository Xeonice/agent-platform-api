import { TerminalSessionService } from '../src/application/terminal-session.service';

/**
 * `TerminalSessionService` 的「不该被调用」替身。
 *
 * ⚠️ **它是个类**（带私有字段），所以 `{...} as TerminalSessionService` 过不了类型检查
 * （TS2352「两个类型重叠不足」）——而仓库禁 `as unknown as` 双重断言。
 * ⇒ 用 `Object.create(prototype)` 拿到真正的实例形状，再把两个公开方法挂上去。
 *
 * ⛔ 方法体一律抛：本组用例本就不该走到它们；真被调到了要的是一条响亮的失败，
 * 而不是一个悄悄生效的空返回。
 */
export function unusedSessions(): TerminalSessionService {
  // ⚠️ 挂在真原型上 —— `Object.create(TerminalSessionService.prototype)` 产出的就是一个
  //    货真价实的实例形状，于是**不需要任何断言**（仓库禁 `as unknown as`）。
  const stub = Object.create(TerminalSessionService.prototype) as TerminalSessionService;
  return Object.assign(stub, {
    openSession: (): never => {
      throw new Error('TerminalSessionService.openSession 不该被这组用例调用');
    },
    bootstrapAgentSession: (): never => {
      throw new Error('TerminalSessionService.bootstrapAgentSession 不该被这组用例调用');
    },
  });
}
