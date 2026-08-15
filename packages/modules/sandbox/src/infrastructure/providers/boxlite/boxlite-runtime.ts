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
