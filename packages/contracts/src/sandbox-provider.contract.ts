/**
 * SandboxProvider SPI — MINIMAL placeholder.
 *
 * ⚠️ The AUTHORITATIVE, complete definition lives in docs/backend/04 §2
 * (`SandboxProvider`, `SandboxProviderCapabilities`, `SandboxHandle`,
 * `ProcessStream`, `SandboxProviderContext`, …), published as
 * `@platform/sandbox-contracts`. Doc 04 is user-maintained and read-only.
 *
 * This file carries only the shape the contract-testkit skeleton (§04 §10)
 * needs to compile and run its SP-01 / CAP-01 assertions. Fill it in from
 * 04 §2 when the SPI is implemented; do NOT redefine 04 here (it caused 6
 * drift bugs before — see 28 §7.1).
 */

/** Boolean capability struct — NOT a numeric bitmask (04 §2.5, testkit CAP-01). */
export interface SandboxProviderCapabilities {
  spawnTty: boolean;
  volumeMount: boolean;
  updateResources: boolean;
  pauseResume: boolean;
  snapshot: boolean;
  watchEvents: boolean;
}

export interface SandboxHandle {
  /** MUST equal the creating provider's `name` (04 SP-01). */
  provider: string;
  ref: string;
}

export interface SandboxProviderContract {
  /** registry key — it is `name`, NOT `id` (04 §2.5, SP-01). */
  readonly name: string;
  readonly capabilities: SandboxProviderCapabilities;
  create(spec: { sandboxId: string }): Promise<SandboxHandle>;
}

export const UNSUPPORTED_CAPABILITY = 'UNSUPPORTED_CAPABILITY';
