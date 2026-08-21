import { z } from 'zod';
import type { SandboxProviderCapabilities } from '../sandbox-provider.contract';
import { SandboxStatusSchema, TimeoutMinutesSchema } from './enums';

/**
 * zod single source (docs/backend/02 §3). These schemas produce, from one place:
 *   - REST DTO (via createZodDto in the interface layer)
 *   - Swagger/OpenAPI reflection (nestjs-zod patchNestJsSwagger)
 *   - MCP tool inputSchema (@Tool parameters)
 * Wire types are camelCase (02 §5.1).
 */

/**
 * The capability bits a create request may DEMAND (04 §5 「创建前静态校验」, the
 * `requireSnapshot` rule generalised to one field per bit). A bit set to `true` that
 * the chosen provider does not advertise → the request is rejected in the application
 * layer BEFORE scheduling, with `UNSUPPORTED_CAPABILITY`.
 *
 * `watchEvents` is deliberately NOT requestable: push-vs-poll is fully encapsulated
 * from callers (04 §5), so "require watchEvents" would mean nothing to an API client.
 */
export const RequiredCapabilitiesSchema = z.object({
  spawnTty: z.boolean().optional(),
  volumeMount: z.boolean().optional(),
  updateResources: z.boolean().optional(),
  pauseResume: z.boolean().optional(),
  snapshot: z.boolean().optional(),
});
export type RequiredCapabilities = z.infer<typeof RequiredCapabilitiesSchema>;

export const CreateSandboxSchema = z.object({
  projectId: z.string().min(1),
  runtime: z.string().min(1),
  image: z.string().optional(),
  provider: z.string().optional(),
  initialPrompt: z.string().optional(),
  headless: z.boolean().optional(),
  timeoutMinutes: TimeoutMinutesSchema.optional(),
  /** Capability preconditions; checked against the provider before scheduling (04 §5). */
  require: RequiredCapabilitiesSchema.optional(),
});
export type CreateSandboxInput = z.infer<typeof CreateSandboxSchema>;

/** Wire mirror of the SPI capability struct (04 §2.5) — all 6 bits, none optional. */
export const SandboxProviderCapabilitiesSchema = z.object({
  spawnTty: z.boolean(),
  volumeMount: z.boolean(),
  updateResources: z.boolean(),
  pauseResume: z.boolean(),
  snapshot: z.boolean(),
  watchEvents: z.boolean(),
});

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;

/**
 * Compile-time parity guard: adding a 7th bit to `SandboxProviderCapabilities` (or
 * renaming one) fails typecheck HERE until the wire schema follows, so `GET /providers`
 * can never quietly under-report what a provider advertises. Exported only so it is a
 * checked declaration rather than dead code — nothing needs to import it.
 */
export type SandboxProviderCapabilitiesWireParity = AssertTrue<
  Exact<z.infer<typeof SandboxProviderCapabilitiesSchema>, SandboxProviderCapabilities>
>;

/**
 * `GET /api/providers` row (04 §5 「能力发现」). Registry-driven: a provider registered
 * out-of-tree appears here automatically, and the frontend shows/hides per-capability
 * controls from `capabilities` instead of hard-coding a provider list.
 */
export const ProviderDtoSchema = z.object({
  name: z.string(),
  capabilities: SandboxProviderCapabilitiesSchema,
  /** True for the provider `create` uses when the request names none. */
  isDefault: z.boolean(),
});
export type ProviderDto = z.infer<typeof ProviderDtoSchema>;

export const ListSandboxesQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
});
export type ListSandboxesQuery = z.infer<typeof ListSandboxesQuerySchema>;

/** DELETE /api/sandboxes/:id body — keepVolume retains the workspace dir (03 §7.7). */
export const DestroySandboxSchema = z.object({
  keepVolume: z.boolean().optional(),
});
export type DestroySandboxInput = z.infer<typeof DestroySandboxSchema>;

export const SandboxDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  runtime: z.string(),
  status: SandboxStatusSchema,
  headless: z.boolean(),
  timeoutMinutes: TimeoutMinutesSchema.nullable(),
  idleTimeoutSec: z.number().int().positive(),
  /** derived, projected from the terminal gateway; never persisted (28 §4). */
  waitingInput: z.boolean(),
  version: z.number().int().nonnegative(),
});
export type SandboxDto = z.infer<typeof SandboxDtoSchema>;
