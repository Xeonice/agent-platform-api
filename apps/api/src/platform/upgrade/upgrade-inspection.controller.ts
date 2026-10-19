import { Body, Controller, HttpCode, Inject, Post, Req, Optional } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { resolve, isAbsolute, dirname, basename } from 'node:path';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import { ConfirmedServiceReleaseSchema, UpgradeComponentsSchema } from '@platform/contracts';
import { UpgradeService } from './upgrade-service';
import { UpgradeInspector } from './upgrade-inspector';
import { requireUpgrade } from './upgrade-trust';
import { loopbackOrigin } from './upgrade-inspection-boundary';
import { rejectRecoveryHeaders } from './upgrade-recovery-authority';
import { readUpgradeCommandStatus } from './upgrade-command-status';
import { ControlApplicationRegistry } from '../control-rpc/control-rpc.module';
import { coordinatorWriterControl } from '../persistence/coordinator-lease';
import { upgradeRecord } from './upgrade-values';

const Json = z.record(z.unknown());
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Id = z.string().uuid();
const Fence = z.number().int().positive();
const Origin = z
  .string()
  .max(1024)
  .refine((value) => {
    try {
      loopbackOrigin(value);
      return true;
    } catch {
      return false;
    }
  });
const Process = z.object({
  instanceId: z.string().min(1).max(64),
  attemptId: Id,
  startIdentity: z.string().min(1).max(180),
  kind: z.enum(['api', 'web', 'coordinator', 'owner', 'installer']),
  artifactDigest: Digest,
  origin: Origin,
  managementOrigin: Origin.optional(),
  pid: z.number().int().positive().nullable().optional(),
});
export const UpgradeInspectionCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('participantCommandStatus'),
      attemptId: Id,
      commandId: z.string().min(1).max(200),
    })
    .strict(),
  z.object({ action: z.literal('writerIdentity') }).strict(),
  z
    .object({
      action: z.literal('commandStatus'),
      attemptId: Id,
      commandKind: z.enum(['coordinator-handoff', 'owner-candidate', 'migration']),
      operationId: z.string().min(1).max(200),
      expectedRequestDigest: Digest.optional(),
    })
    .strict(),
  z.object({ action: z.literal('metadata') }).strict(),
  z.object({ action: z.literal('sourceActual'), forRecovery: z.boolean().optional() }).strict(),
  z
    .object({
      action: z.literal('installedProof'),
      release: ConfirmedServiceReleaseSchema,
      binding: Json.optional(),
    })
    .strict(),
  z.object({ action: z.literal('capture') }).strict(),
  z
    .object({
      action: z.literal('bootstrapProof'),
      release: ConfirmedServiceReleaseSchema,
      artifactRoot: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      action: z.literal('validateSwitch'),
      attemptId: Id,
      fence: Fence,
      input: z
        .object({ manifestDigest: Digest, actual: Json.optional(), candidate: Json.optional() })
        .strict(),
    })
    .strict(),
  z.object({ action: z.literal('processObserve'), input: Process }).strict(),
  z.object({ action: z.literal('controlIdentity'), origin: Origin }).strict(),
  z.object({ action: z.literal('entryBinding') }).strict(),
  z.object({ action: z.literal('webBuild'), binding: Json }).strict(),
  z.object({ action: z.literal('installerIdentity') }).strict(),
  z
    .object({
      action: z.literal('verifySourceArtifact'),
      artifactRoot: z.string().min(1).max(4096),
      expected: UpgradeComponentsSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('authenticationContinuity'),
      attemptId: Id,
      fence: Fence,
      origin: Origin,
    })
    .strict(),
  z.object({ action: z.literal('continuity'), attemptId: Id, fence: Fence }).strict(),
  z.object({ action: z.literal('fallbackEligibility'), attemptId: Id, fence: Fence }).strict(),
]);

/** Fixed semantic operations only. This endpoint has no generic method/SQL/exec port. */
@Controller('internal/upgrades')
export class UpgradeInspectionController {
  constructor(
    private readonly service: UpgradeService,
    private readonly inspector: UpgradeInspector,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() private readonly applications?: ControlApplicationRegistry,
  ) {}

  private artifactRoot(value: string): string {
    requireUpgrade(
      isAbsolute(value) && resolve(value) === value,
      'INSPECTION_ARTIFACT_ROOT_FORBIDDEN',
      400,
    );
    const initial = process.env.UPGRADE_INITIAL_ARTIFACT_ROOT,
      installed = process.env.UPGRADE_INSTALLER_ROOT
        ? resolve(process.env.UPGRADE_INSTALLER_ROOT, 'artifacts')
        : null;
    requireUpgrade(
      value === initial ||
        (installed && dirname(value) === installed && /^[a-f0-9]{64}$/.test(basename(value))),
      'INSPECTION_ARTIFACT_ROOT_FORBIDDEN',
      400,
    );
    return value;
  }

  @Post('inspection')
  @HttpCode(200)
  async inspect(@Req() req: Request, @Body() raw: unknown) {
    this.service.security.internal(req, this.service.store.instanceId);
    requireUpgrade(raw !== undefined, 'INSPECTION_COMMAND_REQUIRED', 400);
    requireUpgrade(
      Buffer.byteLength(JSON.stringify(raw)) <= 128 * 1024,
      'INSPECTION_COMMAND_TOO_LARGE',
      413,
    );
    const parsed = UpgradeInspectionCommandSchema.safeParse(raw);
    requireUpgrade(parsed.success, 'INVALID_INSPECTION_COMMAND', 400);
    const command = parsed.data,
      startedAt = this.clock.now().toISOString();
    if (command.action === 'validateSwitch') rejectRecoveryHeaders(req);
    const attemptId =
      'attemptId' in command
        ? command.attemptId
        : command.action === 'processObserve'
          ? command.input.attemptId
          : undefined;
    return this.service.store.recoveryRequest(req, attemptId, 'read', async () => {
      let result: unknown;
      switch (command.action) {
        case 'participantCommandStatus':
          result = this.service.store.participantCommandStatus(
            command.attemptId,
            command.commandId,
          );
          break;
        case 'writerIdentity': {
          const actual = this.service.store.sqlite
            .prepare<
              unknown[],
              {
                instance_id: string;
                holder_id: string;
                generation: number;
                fence: number;
                expires_at: number;
              }
            >(
              "SELECT instance_id,holder_id,generation,fence,expires_at FROM platform_role_leases WHERE role='state-coordinator'",
            )
            .get();
          requireUpgrade(
            actual?.instance_id === this.service.store.instanceId && this.applications,
            'COORDINATOR_WRITER_IDENTITY_UNKNOWN',
          );
          const application = upgradeRecord(this.applications.identity());
          let writerFenceValid = false;
          try {
            const control = coordinatorWriterControl(this.service.store.sqlite);
            control.assert();
            writerFenceValid =
              control.generation === actual.generation && control.fence === actual.fence;
          } catch {
            /* A prepared/retained reader has no writer capability. */
          }
          result = {
            instanceId: this.service.store.instanceId,
            artifactDigest:
              process.env.PLATFORM_COORDINATOR_ACTUAL_DIGEST ??
              process.env.PLATFORM_ARTIFACT_DIGEST ??
              null,
            startIdentity: process.env.PLATFORM_PROCESS_START_IDENTITY ?? null,
            generation: Number(process.env.COORDINATOR_GENERATION ?? 0),
            writerFenceValid,
            accepting: application.accepting,
            lease: {
              instanceId: actual.instance_id,
              holderId: actual.holder_id,
              generation: actual.generation,
              fence: actual.fence,
              expiresAt: actual.expires_at,
            },
            observedAt: this.clock.now().toISOString(),
          };
          break;
        }
        case 'commandStatus':
          result = readUpgradeCommandStatus(this.service.store, command);
          break;
        case 'metadata':
          result = {
            schema: this.inspector.schema(),
            requiredDataFormats: this.inspector.requiresProjectNameV2()
              ? ['project-name-v2-authority']
              : [],
            defaultImagesSnapshot: this.inspector.defaultImagesSnapshot(),
            observedAt: startedAt,
          };
          break;
        case 'sourceActual':
          result = await this.inspector.sourceActual(command.forRecovery);
          break;
        case 'installedProof':
          result = await this.inspector.installedProof(command.release, command.binding);
          break;
        case 'capture':
          result = await this.inspector.capture();
          break;
        case 'bootstrapProof':
          await this.inspector.bootstrapProof(
            command.release,
            this.artifactRoot(command.artifactRoot),
          );
          result = { qualified: true };
          break;
        case 'validateSwitch':
          result = await this.inspector.validateSwitch(
            command.attemptId,
            command.fence,
            command.input,
          );
          break;
        case 'processObserve':
          result = await this.inspector.processObserve(command.input);
          break;
        case 'controlIdentity':
          result = await this.inspector.controlIdentity(command.origin);
          break;
        case 'entryBinding':
          result = await this.inspector.entryBinding();
          break;
        case 'webBuild':
          result = await this.inspector.webBuild(command.binding);
          break;
        case 'installerIdentity':
          result = await this.inspector.installerIdentity();
          break;
        case 'verifySourceArtifact':
          result = await this.inspector.verifySourceArtifact(
            this.artifactRoot(command.artifactRoot),
            command.expected,
          );
          break;
        case 'authenticationContinuity':
          result = await this.inspector.authenticationContinuity(
            command.attemptId,
            command.fence,
            command.origin,
          );
          break;
        case 'continuity':
          result = await this.inspector.continuity(command.attemptId, command.fence);
          break;
        case 'fallbackEligibility':
          result = await this.service.fallbackEligibility(command.attemptId, command.fence, {});
          break;
      }
      return {
        instanceId: this.service.store.instanceId,
        action: command.action,
        startedAt,
        completedAt: this.clock.now().toISOString(),
        result,
      };
    });
  }
}
