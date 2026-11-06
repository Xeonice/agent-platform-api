import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import { UpgradeContractPlanSchema } from '@platform/contracts';
import { UpgradeSecurity } from '../access-passcode/upgrade-security.service';
import { UpgradeContractBusiness } from './upgrade-contract-business';
import { withContractRequest } from './upgrade-contract-control';
import { rejectRecoveryHeaders } from './upgrade-recovery-authority';
import { requireUpgrade } from './upgrade-trust';

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/),
  Id = z.string().uuid();
const Mutation = z.object({
  contractAttemptId: Id,
  fence: z.number().int().positive(),
  expectedSequence: z.number().int().nonnegative(),
  commandId: z.string().min(1).max(180),
});
export const ContractBusinessCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('metadata'), expandPlanDigest: Digest.optional() }).strict(),
  z.object({ action: z.literal('facts'), plan: UpgradeContractPlanSchema }).strict(),
  z.object({ action: z.literal('budget'), plan: UpgradeContractPlanSchema }).strict(),
  Mutation.extend({ action: z.literal('activate') }).strict(),
  Mutation.extend({ action: z.literal('clear') }).strict(),
  z
    .object({
      action: z.literal('lookup'),
      contractAttemptId: Id,
      commandId: z.string().min(1).max(180),
    })
    .strict(),
]);
/** Fixed business participant operations. No remote SQL, arbitrary method or lifecycle command. */
@Controller('internal/upgrades')
export class UpgradeContractBusinessController {
  constructor(
    private readonly business: UpgradeContractBusiness,
    private readonly security: UpgradeSecurity,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}
  @Post('contract-business')
  @HttpCode(200)
  async execute(@Req() req: Request, @Body() raw: unknown) {
    const instanceId = this.business.store.upgrades.instanceId;
    this.security.internal(req, instanceId);
    rejectRecoveryHeaders(req);
    requireUpgrade(
      raw !== undefined && Buffer.byteLength(JSON.stringify(raw)) <= 128 * 1024,
      'CONTRACT_BUSINESS_COMMAND_TOO_LARGE',
      413,
    );
    const parsed = ContractBusinessCommandSchema.safeParse(raw);
    requireUpgrade(parsed.success, 'INVALID_CONTRACT_BUSINESS_COMMAND', 400);
    const command = parsed.data,
      startedAt = this.clock.now().toISOString();
    let result: unknown;
    if (command.action === 'activate' || command.action === 'clear') {
      result = withContractRequest(
        req,
        this.business.store,
        this.clock,
        command.contractAttemptId,
        () => this.business.execute(command),
      );
    } else if (command.action === 'lookup') {
      requireUpgrade(
        req.headers['x-platform-contract-id'] === undefined ||
          req.headers['x-platform-contract-id'] === command.contractAttemptId,
        'CONTRACT_CONTROL_SCOPE_MISMATCH',
      );
      result = this.business.lookup(command.contractAttemptId, command.commandId);
    } else {
      const read = async () => {
        if (command.action === 'metadata')
          return {
            projectNameAuthoritative: this.business.projectNameAuthoritative(),
            expandAttemptId: command.expandPlanDigest
              ? this.business.expandAttemptId(command.expandPlanDigest)
              : null,
            currentStartIdentity: this.business.currentStartIdentity(),
            ownerRoutes: this.business.ownerRoutes(),
          };
        if (command.action === 'facts') return this.business.contractFacts(command.plan);
        await this.business.budget(command.plan);
        return { qualified: true };
      };
      const contractId = req.headers['x-platform-contract-id'];
      result =
        contractId === undefined && req.headers['x-platform-control-epoch'] === undefined
          ? await read()
          : await withContractRequest(
              req,
              this.business.store,
              this.clock,
              z.string().uuid().parse(contractId),
              read,
            );
    }
    requireUpgrade(
      Buffer.byteLength(JSON.stringify(result)) <= 256 * 1024,
      'CONTRACT_BUSINESS_RESULT_TOO_LARGE',
    );
    return {
      instanceId,
      action: command.action,
      startedAt,
      completedAt: this.clock.now().toISOString(),
      result,
    };
  }
}
