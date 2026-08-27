import { SandboxProviderError, SandboxProviderErrorCode } from '@platform/contracts';

/**
 * Lazy loader + typed handles for the BoxLite micro-VM SDK
 * (`@boxlite-ai/boxlite`, SANDBOX-RUNTIME-DECISIONS 决策 B).
 *
 * The native binary (`@boxlite-ai/boxlite-darwin-arm64`, Apple Hypervisor.framework)
 * is loaded ONLY on first control-plane call — never at module import — so the app
 * boots (and `aio` works) even where BoxLite is absent (Linux CI w/o KVM, missing
 * native dep). Failures surface as a retryable PROVIDER_UNAVAILABLE.
 */
export type BoxliteSdk = typeof import('@boxlite-ai/boxlite');
export type BoxliteRuntime = InstanceType<BoxliteSdk['JsBoxlite']>;
export type BoxliteBox = Awaited<ReturnType<BoxliteRuntime['create']>>;
/**
 * 一次 native `Box.exec` 的句柄（`JsExecution`）—— boxlite 数据面的**唯一**原语
 * （SANDBOX-RUNTIME-DECISIONS 决策 A 修订）。它自带 `stdin()/stdout()/stderr()/
 * wait()/kill()/signal(n)/resizeTty(rows,cols)`，`ProcessStream` 需要的每一件事
 * 在这一层都是原生的，不需要翻译损耗。
 */
export type BoxliteExecution = Awaited<ReturnType<BoxliteBox['exec']>>;
/**
 * 数据面（spawn / files / jobs）真正需要的**全部**能力面：一个 `exec`。
 *
 * 收窄到这一个方法不是洁癖：`JsBox` 上还挂着 snapshot / clone / export / copyIn /
 * copyOut / metrics 十来样东西，而数据面一样都不碰。写成 `Pick` 之后 ① 读代码的人
 * 一眼看到边界在哪，② 单测能用一个只实现 `exec` 的替身把整条数据面**离线**跑通
 * （不需要 hypervisor），而不必为了满足类型去桩十几个用不到的成员。
 */
export type ExecCapableBox = Pick<BoxliteBox, 'exec'>;
export type JsImageRegistry = import('@boxlite-ai/boxlite').JsImageRegistry;

let cached: BoxliteSdk | null = null;

/** Dynamically import the ESM SDK (Node 22 require(esm)); cache the module. */
export async function loadBoxliteSdk(): Promise<BoxliteSdk> {
  if (cached) return cached;
  try {
    cached = await import('@boxlite-ai/boxlite');
    return cached;
  } catch (e) {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
      `BoxLite SDK unavailable (native binary not installed / unsupported platform): ${(e as Error).message}`,
      e,
      true,
    );
  }
}

/**
 * Image registries for the BoxLite runtime (ADR 工程注记): keep `docker.io` (the
 * micro-VM bootstrap base `debian:bookworm-slim`) + the local HTTP mirror that
 * stages large images (BoxLite's own store has no resumable download).
 */
export function boxliteImageRegistries(): JsImageRegistry[] {
  const local = process.env.SANDBOX_BOXLITE_REGISTRY ?? 'localhost:5001';
  return [
    { host: 'docker.io', search: true },
    { host: local, transport: 'http', search: true },
  ];
}

/**
 * PROCESS-level BoxLite runtime — BoxLite permits only ONE runtime per
 * BOXLITE_HOME (~/.boxlite) at a time (exclusive OS directory lock), so every
 * caller in the process (provider AND reconciler) MUST share ONE runtime. Keyed
 * on `globalThis` (a registered Symbol) rather than a module binding because test
 * runners isolate the module registry PER FILE within one process — only
 * globalThis is shared at OS-process scope, matching where the BoxLite lock lives.
 * Created lazily; never at import (platform gating).
 */
const RUNTIME_KEY = Symbol.for('platform.sandbox.boxlite.runtime');
type RuntimeGlobal = { [RUNTIME_KEY]?: Promise<BoxliteRuntime> };

export async function getSharedBoxliteRuntime(): Promise<BoxliteRuntime> {
  const g = globalThis as RuntimeGlobal;
  let runtime = g[RUNTIME_KEY];
  if (!runtime) {
    runtime = loadBoxliteSdk().then(
      (sdk) => new sdk.JsBoxlite({ imageRegistries: boxliteImageRegistries() }),
    );
    g[RUNTIME_KEY] = runtime;
  }
  return runtime;
}
