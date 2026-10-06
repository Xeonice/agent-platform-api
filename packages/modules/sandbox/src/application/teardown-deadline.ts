import { SandboxProviderError, SandboxProviderErrorCode } from '@platform/contracts';

/** A wedged force removal must settle so durable cleanup can attempt it again. */
export async function withTeardownDeadline(
  removal: Promise<void>,
  sandboxId: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new SandboxProviderError(
            SandboxProviderErrorCode.TIMEOUT,
            `任务 ${sandboxId} 的运行环境没有在限定时间内删除。`,
            undefined,
            true,
          ),
        ),
      15_000,
    );
  });
  try {
    await Promise.race([removal, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
