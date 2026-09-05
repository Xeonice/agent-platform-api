/**
 * 把「回调报进度」的操作变成 `AsyncIterable` —— 让 `async function*` 能**边跑边 yield**。
 *
 * ── 它修的是什么：一个把进度条变成假货的写法 ────────────────────────────────
 * 生成器里不能从回调内部 `yield`。最容易写出的绕法是先把回调推进数组、等操作结束再一起
 * yield：
 *
 * ```ts
 * const sink = [];
 * await docker.push(ref, (p, m) => sink.push(ev(p, m)));   // ⛔ 全程静默
 * for (const e of sink) yield e;                            // ⛔ 结束后一次性喷出
 * ```
 *
 * ⛔ **那不是进度，是回放。** 用户在几分钟的推送里一个字都看不到，屏幕上的进度条停在
 * 0% —— 与「卡死了」在观感上完全一致，然后在它已经没有意义的时刻突然跳到 100%。
 * **一个假的进度条比没有进度条更糟**：没有的时候用户知道该等，有的时候他以为它挂了。
 *
 * ⇒ 用一个带背压的队列把两端接起来：回调侧 `push`，消费侧 `for await`。
 */
export class CallbackStream<T> {
  private readonly queue: T[] = [];
  private waiting: (() => void) | null = null;
  private done = false;
  private failure: unknown = null;

  /** 回调侧调用。 */
  push(item: T): void {
    this.queue.push(item);
    this.wake();
  }

  /** 操作正常结束。 */
  finish(): void {
    this.done = true;
    this.wake();
  }

  /**
   * 操作失败。
   *
   * ⚠️ **错误要从消费端抛出来，不能只是停住。** 只 `finish()` 的话消费方会以为一切正常
   * 结束 —— 那正是「少报是降级，多报是撒谎」里更糟的那一半：一次失败的搬运看起来成功了。
   */
  fail(err: unknown): void {
    this.failure = err;
    this.done = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiting;
    if (w !== null) {
      this.waiting = null;
      w();
    }
  }

  async *drain(): AsyncGenerator<T> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.done) break;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
    // ⚠️ 队列先排空再抛：失败前已经发生的进度对排障有用（「推到 80% 才断」与
    //    「一开始就断」是两个不同的问题），丢掉它们等于把线索一起丢了。
    if (this.failure !== null) throw this.failure;
  }
}

/**
 * 跑一个回调式操作，边跑边把回调产物 yield 出去。
 *
 * ⚠️ **不 `await` 那个 promise 就开始 drain** —— 先 await 再 drain 就退化成上面那种回放。
 */
export async function* streamed<T>(
  run: (emit: (item: T) => void) => Promise<void>,
): AsyncGenerator<T> {
  const s = new CallbackStream<T>();
  void run((item) => {
    s.push(item);
  }).then(
    () => {
      s.finish();
    },
    (e: unknown) => {
      s.fail(e);
    },
  );
  yield* s.drain();
}
