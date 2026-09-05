/**
 * 「这组用例不该碰它」的替身 —— 被调用就**响亮地抛**。
 *
 * ── 它替代的是什么 ──────────────────────────────────────────────────────────
 * 构造函数后来加了一个依赖，而这组用例根本不走那条路。三种常见写法里两种是坏的：
 *
 *  ⛔ `{} as Foo` —— 双重断言的近亲，仓库规则禁；而且真被调到时报的是
 *     `undefined is not a function`，看不出「这条路径本不该走到这里」。
 *  ⛔ 一个返回假值的空壳 —— 更糟：它让一条**不该发生**的调用**悄悄成功**，
 *     于是用例绿着，而它验的东西已经不是原来那件事了。
 *  ✅ 被调用就抛，并把方法名说出来。
 *
 * ⚠️ 这批缺口是 2026-09-05 打开测试 typecheck 后一次性暴露的 —— 在那之前，
 * 「构造签名变了、测试没跟」在类型上无人看管，只有真跑到那一行才会发现。
 */
export function unused<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      throw new Error(`${what}.${String(prop)} 不该被这组用例调用`);
    },
  });
}

/**
 * 从领域事件上取一个字段 —— 替代 `(e as { ref: string }).ref` 那种断言。
 *
 * ── 为什么不用 `as` ────────────────────────────────────────────────────────
 * `DomainEvent` 是个窄基类，断言成 `{ ref: string }` 会被 TS 判为「两个类型重叠不足」
 * （TS2352），只能靠 `as unknown as` 双重断言绕 —— 而那是仓库规则明令禁止的。
 *
 * ⛔ 更要紧的是**断言什么都不检查**：字段名写错（`ref` 打成 `refs`）时，
 * `(e as {refs:string}).refs` 是 `undefined`，断言 `.not.toContain(...)` 照样**通过**。
 * ⇒ 这里在运行期真的看一眼字段在不在，不在就抛 —— 拼错字段名从此当场红。
 */
export function eventField<T>(event: object, field: string): T {
  if (!(field in event)) {
    throw new Error(`事件 ${event.constructor.name} 上没有字段 '${field}' —— 断言的字段名写错了？`);
  }
  return (event as Record<string, unknown>)[field] as T;
}

/**
 * `CredentialRepository` 里 git 凭证那组用例**用不到**的五个方法。
 *
 * ⚠️ 摊进替身里补全契约（`satisfies CredentialRepository` 才过）。方法体一律抛 ——
 * 被调到要响亮地失败，⛔ 不返回空数组让用例在一条不该走的路上继续绿着。
 *
 * ⚠️ 这五个方法是陆续加上去的，而**测试代码此前没被 typecheck 看过**，
 * 所以三个替身都停在了旧契约上（2026-09-05 补齐）。
 */
export const unusedCredentialReads = {
  listByRuntime: (): never => {
    throw new Error('CredentialRepository.listByRuntime 不该被这组用例调用');
  },
  listRefreshDue: (): never => {
    throw new Error('CredentialRepository.listRefreshDue 不该被这组用例调用');
  },
  listExpiringBefore: (): never => {
    throw new Error('CredentialRepository.listExpiringBefore 不该被这组用例调用');
  },
  refreshSync: (): never => {
    throw new Error('CredentialRepository.refreshSync 不该被这组用例调用');
  },
  recordRefreshFailureSync: (): never => {
    throw new Error('CredentialRepository.recordRefreshFailureSync 不该被这组用例调用');
  },
};
