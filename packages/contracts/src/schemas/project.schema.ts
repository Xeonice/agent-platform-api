import { z } from 'zod';

/**
 * Project zod single source (docs/backend/02 §3, 13 §2.2, shared/10 §6). One place
 * produces the REST DTO, the OpenAPI reflection, and the MCP tool inputSchema.
 *
 * IMPORTANT product decision: `ProjectDto` does NOT expose `repoUrl`/`repoBranch`
 * — the project's SOURCE is never shown to clients (shared/10 §6). The create
 * request accepts them (git needs a url), but they never round-trip out.
 */
export const ProjectSourceTypeSchema = z.enum(['git', 'empty']);
export type ProjectSourceType = z.infer<typeof ProjectSourceTypeSchema>;

/** clone lifecycle (03 §7.2 / 13 §2.2). empty projects are `ready` immediately. */
export const CloneStatusSchema = z.enum(['cloning', 'ready', 'failed']);
export type CloneStatus = z.infer<typeof CloneStatusSchema>;

/** clone failure taxonomy (03 §7.5), 5 values; permission matched before network. */
export const CloneErrorCodeSchema = z.enum([
  'CLONE_FAILED_PERMISSION',
  'CLONE_FAILED_NETWORK',
  'TIMEOUT',
  'INTERRUPTED',
  'DISK_INSUFFICIENT',
]);
export type CloneErrorCode = z.infer<typeof CloneErrorCodeSchema>;

/** how the workspace is filled from the baseline (03 §7.1). S2: reflink-aware copy. */
export const WorkspaceModeSchema = z.enum(['copy']);
export type WorkspaceMode = z.infer<typeof WorkspaceModeSchema>;

/**
 * Create request. The git⇒repoUrl / empty⇒no-repoUrl invariant (I-PRJ-1) is a
 * plain object here (clean OpenAPI reflection) and enforced in the application
 * (→ 400) + the domain — not as a zod `.refine` (which produces a ZodEffects that
 * createZodDto/Swagger cannot introspect for properties).
 */
export const CreateProjectSchema = z.object({
  name: z.string().min(1).max(40), // I-PRJ-4: name length 1–40 (13/23)
  sourceType: ProjectSourceTypeSchema,
  repoUrl: z.string().min(1).max(2048).optional(),
  repoBranch: z.string().min(1).max(255).optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

/** DELETE /:id body — keepBaseline retains the baseline dir on disk. */
export const DeleteProjectSchema = z.object({ keepBaseline: z.boolean().optional() });
export type DeleteProjectInput = z.infer<typeof DeleteProjectSchema>;

/**
 * ProjectDto — the OUTBOUND shape (shared/10 §7). MINIMAL: no source (repoUrl/
 * repoBranch), no internal fields (workspaceMode / baselineSizeBytes / updatedAt).
 * `taskCount` is the aggregated count of live Tasks (= sandboxes, 23 D-1) under the
 * project, filled by the application via the cross-context SandboxFacade.
 */
export const ProjectDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  sourceType: ProjectSourceTypeSchema,
  cloneStatus: CloneStatusSchema,
  cloneErrorCode: CloneErrorCodeSchema.nullable(),
  taskCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type ProjectDto = z.infer<typeof ProjectDtoSchema>;
