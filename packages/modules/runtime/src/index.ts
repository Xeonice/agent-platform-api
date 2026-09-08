// Public surface of the runtime context consumed by the app assembly.
export { RuntimeModule } from './interface/runtime.module';
export { RuntimeApplicationService } from './application/runtime-application.service';
export {
  runtimeSettings,
  runtimeInstallations,
} from './infrastructure/persistence/schema/runtime.sqlite';
// 领域事件类 —— 供平台级 `AuditProjector` 判别（理由见 sandbox 包同一处注释）。
export {
  RuntimeInstallationStateChanged,
  RuntimeAuthModeChanged,
} from './domain/events/runtime-events';

/**
 * ── ADAPTER REUSABLES (04 §8 ★8b「可复用件」) ────────────────────────────────
 *
 * Everything an out-of-tree `RuntimeAdapter` genuinely needs and would otherwise have
 * to re-derive. Until now this package exported four things, none of them these — so
 * the documented extension point shipped without the parts that make an adapter
 * CORRECT, and every third party would reimplement them from scratch.
 *
 * ⛔ `WRITE_FILE_SCRIPT` / `writeCredentialFile` are the ones that matter most, and the
 * reason is not convenience: the `umask 077` inside that shell one-liner closes the
 * window between `cat >` creating the credential file and `chmod` tightening it. A
 * hand-written copy that omits it leaves the file world-readable inside the sandbox for
 * as long as the write takes — and **RA-14/15/16 cannot catch that**, because the bytes
 * the adapter sends are byte-identical either way. A shared export is the only place
 * that hazard can be stated once and honoured everywhere.
 *
 * ⚠️ `probeSandboxHome` is the second: hard-coding `/home/gem` is measurably tempting
 * (both built-in providers happen to report it) and 04 §7 explicitly refuses to make
 * HOME part of the image contract.
 */
export {
  WRITE_FILE_SCRIPT,
  CREDENTIAL_FILE_MODE,
  writeCredentialFile,
} from './infrastructure/adapters/credential-file.util';
export { probeSandboxHome, SEED_WRITE_TIMEOUT_MS } from './infrastructure/adapters/home-probe.util';
export {
  imagePreinstalls,
  npmInstallPlan,
  probeOnPath,
  runInstallCommands,
} from './infrastructure/adapters/install-plan.util';
export { readUntil } from './infrastructure/adapters/pty-reader.util';
export { assertSessionRef } from './infrastructure/adapters/session-ref.util';
export { stripAnsi, extractOsc8Urls } from './infrastructure/adapters/ansi.util';
