/** {@link within} 到点时给的那个值 —— 与任何正常结果都不相等。 */
export const TIMED_OUT = Symbol('timed-out');

/**
 * 限时等一个 promise；到点给 {@link TIMED_OUT}。
 *
 * ⚠️ 只是不再等，⛔ 不取消：到点之后 `work` 照样跑完，它的结果没人读。
 * ⚠️ 定时器 `unref` 并且必清，不让进程为它醒着。
 */
export async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
