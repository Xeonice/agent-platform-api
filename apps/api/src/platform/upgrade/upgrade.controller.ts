import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiExtraModels,
  ApiHeader,
  getSchemaPath,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  UpgradeContractRequestSchema,
  UpgradeContractAttemptSchema,
  UpgradeAccessSchema,
  UpgradeAttemptSchema,
  UpgradeRequestSchema,
  UpgradeStatusSchema,
  UpgradeOperationSchema,
} from '@platform/contracts';
import type { Request, Response } from 'express';
import { UpgradeService } from './upgrade-service';
import { requireUpgrade } from './upgrade-trust';
import { CoordinatorHandoff } from './coordinator-handoff';
import { UpgradeRoleHandoffs } from './upgrade-role-handoffs';
import { UpgradeObserver } from './upgrade-observer';
import { UpgradeOnlineMigration } from './upgrade-online-migration';
import { CoordinatorRecovery } from './coordinator-recovery';
import { UpgradeContractService } from './upgrade-contract-service';
import { rejectRecoveryHeaders } from './upgrade-recovery-authority';
import { authorizeUpgradeProbe } from './upgrade-probe-auth';

export class UpgradeContractRequestDto extends createZodDto(UpgradeContractRequestSchema) {}
export class UpgradeContractAttemptDto extends createZodDto(UpgradeContractAttemptSchema) {}
export class UpgradeRequestDto extends createZodDto(UpgradeRequestSchema) {}
export class UpgradeAccessDto extends createZodDto(UpgradeAccessSchema) {}
export class UpgradeStatusDto extends createZodDto(UpgradeStatusSchema) {}
export class UpgradeAttemptDto extends createZodDto(UpgradeAttemptSchema) {}
export class UpgradeOperationDto extends createZodDto(UpgradeOperationSchema) {}
const commandResponse = {
  oneOf: [{ $ref: getSchemaPath(UpgradeAttemptDto) }, { $ref: getSchemaPath(UpgradeOperationDto) }],
};
export class UpgradeProbeDto extends createZodDto(
  z
    .object({
      attemptId: z.string().uuid(),
      fence: z.number().int().positive(),
      requestId: z.string().uuid(),
      value: z.string().max(256),
    })
    .strict(),
) {}

@ApiTags('upgrade')
@ApiExtraModels(UpgradeAttemptDto, UpgradeOperationDto)
@Controller('system/upgrade')
export class UpgradeController {
  constructor(private readonly upgrades: UpgradeService) {}
  @Get('status')
  @ApiOkResponse({ type: UpgradeStatusDto })
  status(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.upgrades.status(req, res);
  }
  @Post('access')
  @ApiOperation({
    deprecated: true,
    summary: 'Compatibility endpoint; instance access already permits upgrades',
  })
  @HttpCode(200)
  @ApiOkResponse({ type: UpgradeStatusDto })
  access(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() input: UpgradeAccessDto,
  ) {
    const grant = this.upgrades.security.grant(
      req,
      res,
      this.upgrades.store.instanceId,
      input.upgradeKey,
    );
    return this.upgrades.status(req, res, grant);
  }
  @Post('requests')
  @HttpCode(202)
  @ApiHeader({
    name: 'Prefer',
    required: false,
    description:
      'respond-async admits one durable final-target operation; omitted preserves the legacy technical-attempt response.',
  })
  @ApiAcceptedResponse({ schema: commandResponse })
  request(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() input: UpgradeRequestDto,
  ) {
    return this.upgrades.request(req, res, input);
  }
  @Get('requests/:requestId')
  @ApiHeader({
    name: 'Prefer',
    required: false,
    description:
      'respond-async looks up the original user operation. Existing legacy attempts remain readable.',
  })
  @ApiOkResponse({ schema: commandResponse })
  lookup(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('requestId') id: string,
  ) {
    requireUpgrade(z.string().uuid().safeParse(id).success, 'INVALID_REQUEST_ID', 400);
    return this.upgrades.lookup(req, res, id);
  }
  @Post('contracts/requests')
  @HttpCode(202)
  @ApiAcceptedResponse({ type: UpgradeContractAttemptDto })
  contractRequest(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() input: UpgradeContractRequestDto,
  ) {
    requireUpgrade(this.upgrades.contracts, 'CONTRACT_UNAVAILABLE');
    return this.upgrades.contracts.request(req, res, input);
  }
  @Get('contracts/requests/:requestId')
  @ApiOkResponse({ type: UpgradeContractAttemptDto })
  contractLookup(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('requestId') id: string,
  ) {
    requireUpgrade(z.string().uuid().safeParse(id).success, 'INVALID_REQUEST_ID', 400);
    requireUpgrade(this.upgrades.contracts, 'CONTRACT_UNAVAILABLE');
    return this.upgrades.contracts.lookup(req, res, id);
  }
  @Post('probe')
  @HttpCode(200)
  probe(@Req() req: Request, @Body() input: UpgradeProbeDto) {
    authorizeUpgradeProbe(req, this.upgrades.store.instanceId, () => {
      this.upgrades.security.internal(req, this.upgrades.store.instanceId);
    });
    return this.upgrades.store.recoveryRequest(req, input.attemptId, 'observe', () =>
      this.upgrades.probe(input),
    );
  }
  @Get('probe')
  readProbe(@Req() req: Request, @Query('requestId') id: string) {
    authorizeUpgradeProbe(req, this.upgrades.store.instanceId, () => {
      this.upgrades.security.internal(req, this.upgrades.store.instanceId);
    });
    requireUpgrade(z.string().uuid().safeParse(id).success, 'INVALID_PROBE_ID', 400);
    return this.upgrades.store.recoveryRequest(req, undefined, 'observe', () =>
      this.upgrades.readProbe(id),
    );
  }
}

const ClaimSchema = z
  .object({ controllerId: z.string().min(1), leaseMs: z.number().int().min(500).max(120000) })
  .strict();
const RenewSchema = z
  .object({
    controllerId: z.string().nullable(),
    fence: z.number().int().positive(),
    checkOnly: z.boolean().optional(),
  })
  .strict();
const AuthorityCheckSchema = z
  .object({
    fence: z.number().int().positive(),
    generation: z.number().int().positive().optional(),
  })
  .strict();
const LeaseRenewSchema = z
  .object({
    fence: z.number().int().positive(),
    generation: z.number().int().positive(),
    controllerId: z.string().min(1).max(180),
  })
  .strict();
const CheckpointQuerySchema = z
  .object({
    fence: z.coerce.number().int().positive(),
    generation: z.coerce.number().int().positive(),
  })
  .strict();
const CommitSchema = z
  .object({
    fence: z.number().int().positive(),
    generation: z.number().int().positive(),
    expectedSequence: z.number().int().nonnegative(),
    eventId: z.string().uuid(),
    kind: z.enum([
      'progress',
      'step-applied',
      'deferred',
      'failed',
      'activation-confirmed',
      'ready-revoked',
      'recovery-started',
      'recovery-confirmed',
      'recovery-failed',
    ]),
    payload: z.record(z.unknown()),
  })
  .strict();

@Controller('internal/upgrades')
export class UpgradeInternalController {
  constructor(
    private readonly upgrades: UpgradeService,
    private readonly handoff: CoordinatorHandoff,
    private readonly roles: UpgradeRoleHandoffs,
    private readonly observer: UpgradeObserver,
    private readonly migrations: UpgradeOnlineMigration,
    private readonly recovery: CoordinatorRecovery,
  ) {}
  private auth(req: Request, recovery = false): void {
    this.upgrades.security.internal(req, this.upgrades.store.instanceId);
    if (!recovery) rejectRecoveryHeaders(req);
  }
  @Get('controller-capabilities') controlCapabilities(@Req() req: Request) {
    this.auth(req);
    return this.upgrades.store.controlCapabilities();
  }
  @Get('pending') pending(@Req() req: Request) {
    this.auth(req);
    return this.upgrades.store.pending();
  }
  @Post('process-observe') @HttpCode(200) processObserve(
    @Req() req: Request,
    @Body() input: Record<string, unknown>,
  ) {
    this.auth(req);
    return this.upgrades.inspector.processObserve(input);
  }
  @Get('continuity') continuity(
    @Req() req: Request,
    @Query('attemptId') id: string,
    @Query('fence') fence: string,
  ) {
    this.auth(req, true);
    return this.upgrades.store.recoveryRequest(req, id, 'read', () =>
      this.upgrades.inspector.continuity(id, Number(fence)),
    );
  }
  @Get('observation') observation(
    @Req() req: Request,
    @Query('attemptId') id: string,
    @Query('fence') fence: string,
    @Query('weight') weight: string,
  ) {
    this.auth(req, true);
    return this.upgrades.store.recoveryRequest(req, id, 'observe', () =>
      this.observer.observation(id, Number(fence), Number(weight)),
    );
  }
  @Post('bootstrap') @HttpCode(200) async bootstrap(@Req() req: Request) {
    this.auth(req);
    await this.upgrades.registerInstalled();
    return this.upgrades.store.confirmed();
  }
  @Get(':attemptId') snapshot(@Req() req: Request, @Param('attemptId') id: string) {
    this.auth(req);
    return this.upgrades.store.snapshot(id);
  }
  @Post(':attemptId/claim') @HttpCode(200) claim(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Body() raw: unknown,
  ) {
    this.auth(req);
    const input = ClaimSchema.parse(raw);
    return this.upgrades.claim(id, input.controllerId, input.leaseMs);
  }
  @Post(':attemptId/authority-check') @HttpCode(200) authorityCheck(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Body() raw: unknown,
  ) {
    this.auth(req);
    const input = AuthorityCheckSchema.parse(raw);
    return this.upgrades.store.authorityCheck(id, input.fence, input.generation);
  }
  @Post(':attemptId/lease-renew') @HttpCode(200) leaseRenew(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Body() raw: unknown,
  ) {
    this.auth(req);
    const input = LeaseRenewSchema.parse(raw);
    return this.upgrades.store.leaseRenew(id, input.fence, input.generation, input.controllerId);
  }
  @Get(':attemptId/progress-checkpoint') checkpoint(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Query() raw: unknown,
  ) {
    this.auth(req);
    const input = CheckpointQuerySchema.parse(raw);
    return this.upgrades.store.progressCheckpoint(id, input.fence, input.generation);
  }
  @Post(':attemptId/commit-receipt') @HttpCode(200) commitReceipt(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Body() raw: unknown,
  ) {
    this.auth(req);
    return this.upgrades.commitReceipt(id, CommitSchema.parse(raw));
  }
  @Post(':attemptId/renew') @HttpCode(200) renew(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Body() raw: unknown,
  ) {
    this.auth(req);
    const input = RenewSchema.parse(raw);
    return this.upgrades.store.renew(id, input.fence, input.controllerId, input.checkOnly);
  }
  @Post(':attemptId/commit') @HttpCode(200) commit(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Body() raw: unknown,
  ) {
    this.auth(req);
    return this.upgrades.commit(id, CommitSchema.parse(raw));
  }
  @Get(':attemptId/steps/:stepId') step(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Param('stepId') step: string,
  ) {
    this.auth(req);
    return this.upgrades.store.step(id, step);
  }
  @Post(':attemptId/validate-switch') @HttpCode(200) validate(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Body() input: Record<string, unknown>,
  ) {
    this.auth(req);
    return this.upgrades.inspector.validateSwitch(id, Number(input.fence), input);
  }
  @Post(':attemptId/fallback-eligibility') @HttpCode(200) fallback(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Body() input: Record<string, unknown>,
  ) {
    this.auth(req, true);
    return this.upgrades.store.recoveryRequest(req, id, 'read', () =>
      this.upgrades.fallbackEligibility(id, Number(input.fence), input),
    );
  }
  @Post(':attemptId/coordinator-handoff') @HttpCode(200) coordinatorHandoff(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Body() input: Record<string, unknown>,
  ) {
    this.auth(req);
    return this.upgrades.store.businessAction(req.headers, id, 'coordinatorHandoff', input, () =>
      this.handoff.execute(id, input),
    );
  }
  @Post(':attemptId/owner-candidate') @HttpCode(200) ownerCandidate(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Body() input: Record<string, unknown>,
  ) {
    this.auth(req);
    return this.upgrades.store.businessAction(req.headers, id, 'ownerCandidate', input, () =>
      this.roles.execute(id, 'owner', input),
    );
  }
  @Post(':attemptId/controller-handoff') @HttpCode(200) controllerHandoff(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Body() input: Record<string, unknown>,
  ) {
    this.auth(req);
    return this.roles.execute(id, 'installer', input);
  }
  @Post(':attemptId/migration') @HttpCode(200) migration(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Body() input: Record<string, unknown>,
  ) {
    this.auth(req);
    return this.upgrades.store.businessAction(req.headers, id, 'migration', input, () =>
      this.migrations.execute(id, input),
    );
  }
  @Post(':attemptId/coordinator-compatibility') @HttpCode(200) compatibility(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Body() input: Record<string, unknown>,
  ) {
    this.auth(req, true);
    return this.upgrades.store.recoveryRequest(req, id, 'read', () =>
      this.recovery.compatibility(id, Number(input.fence)),
    );
  }
  @Post(':attemptId/recovery-admission') @HttpCode(200) recoveryAdmission(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Body() raw: unknown,
  ) {
    this.auth(req, true);
    const input = z.object({ fence: z.number().int().positive() }).strict().parse(raw);
    return this.upgrades.store.recoveryRequest(req, id, 'admit', () =>
      this.upgrades.store.admitRecovery(id, input.fence),
    );
  }
  @Get(':attemptId/recovery-actions') recoveryActions(
    @Req() req: Request,
    @Param('attemptId') id: string,
  ) {
    this.auth(req, true);
    return this.upgrades.store.recoveryRequest(req, id, 'read', () =>
      this.upgrades.store.recoveryActions(id),
    );
  }
  @Post(':attemptId/stabilize-current-writer') @HttpCode(200) stabilizeCurrentWriter(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Body() raw: unknown,
  ) {
    this.auth(req, true);
    const parsed = z
      .object({ fence: z.number().int().positive(), operationId: z.string().min(1).max(200) })
      .strict()
      .safeParse(raw);
    requireUpgrade(parsed.success, 'INVALID_STABILIZATION_COMMAND', 400);
    return this.upgrades.store.recoveryRequest(req, id, 'stabilize', () =>
      this.upgrades.store.recoveryAction(id, 'stabilize-current-writer', parsed.data, () =>
        this.recovery.stabilize(id, parsed.data),
      ),
    );
  }
  @Post(':attemptId/coordinator-recovery') @HttpCode(200) recoverCoordinator(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Body() input: Record<string, unknown>,
  ) {
    this.auth(req, true);
    return this.upgrades.store.recoveryRequest(req, id, 'restore', () =>
      this.upgrades.store.recoveryAction(id, 'coordinator-recovery', input, () =>
        this.recovery.execute(id, input),
      ),
    );
  }
  @Post(':attemptId/coordinator-resume') @HttpCode(200) resumeCoordinator(
    @Req() req: Request,
    @Param('attemptId') id: string,
    @Body() input: Record<string, unknown>,
  ) {
    this.auth(req, true);
    return this.upgrades.store.recoveryRequest(req, id, 'restore', () =>
      this.upgrades.store.recoveryAction(id, 'coordinator-resume', input, () =>
        this.recovery.resume(id, input),
      ),
    );
  }
}

@Controller('internal/contracts')
export class UpgradeContractInternalController {
  constructor(
    private readonly contracts: UpgradeContractService,
    private readonly upgrades: UpgradeService,
  ) {}
  @Get(':id') snapshot(@Req() req: Request, @Param('id') id: string) {
    this.upgrades.security.internal(req, this.upgrades.store.instanceId);
    return this.contracts.store.snapshot(id);
  }
  @Post(':id/check') @HttpCode(200) check(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    this.upgrades.security.internal(req, this.upgrades.store.instanceId);
    const body = z.object({ fence: z.number().int().positive() }).strict().parse(raw);
    return this.contracts.check(id, body.fence);
  }
}
