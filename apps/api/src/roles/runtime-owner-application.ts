import { Global, Module, type Type, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import { SANDBOX_PROVIDER_REGISTRY, type ProviderRegistry } from '@platform/contracts';
import {
  RuntimeOwnerModule,
  acquireRuntimeOwnerHomeLock,
  startRuntimeOwnerFromEnvironment,
} from '@platform/sandbox';
import { SystemClock } from '../platform/time/system-clock';

/** Owner-only composition root. Installations import this module together with
 * their trusted Provider modules; RuntimeAdapter/ImageSpec modules stay in the
 * Coordinator. No application modules, business DB, scheduler or browser API. */
@Global()
@Module({
  imports: [RuntimeOwnerModule],
  providers: [{ provide: CLOCK, useClass: SystemClock }],
  exports: [CLOCK],
})
export class RuntimeOwnerApplicationModule {}

/** A trusted, statically imported installation module is the only extension input.
 * Registration is complete (including async hooks) before any Owner RPC listens. */
export async function startRuntimeOwnerApplication(
  composition: Type<unknown> = RuntimeOwnerApplicationModule,
): Promise<Awaited<ReturnType<typeof startRuntimeOwnerFromEnvironment>>> {
  const lock = acquireRuntimeOwnerHomeLock();
  let context: INestApplication | undefined;
  try {
    // createApplicationContext() hides its handle when an init hook rejects.
    // An unlistened Nest app gives us explicit init/close ownership instead. It
    // never listens; only the authenticated RuntimeOwnerServer below does.
    context = await NestFactory.create(composition, {
      logger: false,
      abortOnError: false,
      bodyParser: false,
    });
    await context.init();
    const owner = await startRuntimeOwnerFromEnvironment(
      context.get<Clock>(CLOCK),
      context.get<ProviderRegistry>(SANDBOX_PROVIDER_REGISTRY),
      lock,
    );
    const initialized = context;
    let closing: Promise<void> | undefined;
    return {
      server: owner.server,
      close: () =>
        (closing ??= (async () => {
          try {
            await owner.close();
          } finally {
            try {
              await initialized.close();
            } finally {
              lock.release();
            }
          }
        })()),
    };
  } catch (error) {
    try {
      await context?.close();
    } finally {
      lock.release();
    }
    throw error;
  }
}
