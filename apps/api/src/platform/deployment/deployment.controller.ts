import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { DATABASE, builtinImageRefFor } from '@platform/shared-kernel';
import { IMAGE_FACADE, SANDBOX_PROVIDER_REGISTRY } from '@platform/contracts';
import type { ImageFacade, ProviderRegistry } from '@platform/contracts';
import { RuntimeApplicationService } from '@platform/runtime';
import { assertBoxliteSdkAvailable } from '@platform/sandbox';
import type { Db } from '../persistence/drizzle.connection';
import { DeploymentState } from './deployment-state';

const DeploymentStatusSchema = z.object({
  ready: z.boolean(),
  draining: z.boolean(),
  idle: z.boolean(),
  readiness: z.object({ database: z.boolean(), provider: z.boolean(), image: z.boolean() }),
  inFlightHTTP: z.number().int().nonnegative(),
  activeWS: z.number().int().nonnegative(),
  credentialAuth: z.number().int().nonnegative(),
  blockers: z.object({
    sandboxes: z.number().int().nonnegative(),
    agentTasks: z.number().int().nonnegative(),
    automationRuns: z.number().int().nonnegative(),
    enabledAutomations: z.number().int().nonnegative(),
    resourceAllocations: z.number().int().nonnegative(),
    cloningProjects: z.number().int().nonnegative(),
    projectCleanupJobs: z.number().int().nonnegative(),
  }),
});
class DeploymentStatusDto extends createZodDto(DeploymentStatusSchema) {}

/** Operational read-only probe. The regular passcode guard also protects this controller. */
@ApiTags('system')
@Controller('deployment')
export class DeploymentController {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly state: DeploymentState,
    private readonly runtimes: RuntimeApplicationService,
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly providers: ProviderRegistry,
    @Inject(IMAGE_FACADE) private readonly images: ImageFacade,
  ) {}

  @Get('status')
  @ApiOperation({
    summary:
      'Read-only deployment barrier, idle blockers and DB/SDK/image-registration readiness (no VM probe)',
  })
  @ApiOkResponse({ type: DeploymentStatusDto })
  async status(): Promise<z.infer<typeof DeploymentStatusSchema>> {
    const readiness = { database: false, provider: false, image: false };
    try {
      const quick = this.db.all<{ quick_check: string }>(sql`PRAGMA quick_check(1)`);
      readiness.database =
        quick.length === 1 &&
        quick[0]?.quick_check === 'ok' &&
        this.db.all(sql`PRAGMA foreign_key_check`).length === 0;
    } catch {
      /* A failed read is not readiness. */
    }
    const provider = this.providers.defaultProvider;
    try {
      readiness.provider = this.providers.has(provider);
      if (provider === 'boxlite') await assertBoxliteSdkAvailable();
    } catch {
      readiness.provider = false;
    }
    try {
      const image = await this.images.findRegisteredByRef(builtinImageRefFor(provider));
      readiness.image =
        image !== null && image.isActive && ['valid', 'warning'].includes(image.validationStatus);
    } catch {
      /* Missing image registration keeps readiness false. */
    }
    const blockers = {
      sandboxes: this.count(
        sql`select count(*) as count from sandboxes where status not in ('stopped','failed','destroyed')`,
      ),
      agentTasks: this.count(
        sql`select count(*) as count from agent_tasks where status = 'running'`,
      ),
      automationRuns: this.count(
        sql`select count(*) as count from automation_runs where status in ('pending','running')`,
      ),
      enabledAutomations: this.count(
        sql`select count(*) as count from automations where enabled = 1`,
      ),
      resourceAllocations: this.count(
        sql`select count(*) as count from resource_allocations where released_at is null`,
      ),
      cloningProjects: this.count(
        sql`select count(*) as count from projects where clone_status = 'cloning'`,
      ),
      projectCleanupJobs: this.count(
        sql`select count(*) as count from sandbox_project_cleanup_jobs`,
      ),
    };
    const { draining, inFlightHTTP, activeWS } = this.state;
    const credentialAuth = this.runtimes.activeAuthCount();
    return {
      ready: Object.values(readiness).every(Boolean),
      readiness,
      draining,
      blockers,
      inFlightHTTP,
      activeWS,
      credentialAuth,
      idle:
        Object.values(blockers).every((n) => n === 0) &&
        inFlightHTTP === 0 &&
        activeWS === 0 &&
        credentialAuth === 0,
    };
  }

  private count(query: ReturnType<typeof sql>): number {
    const row = this.db.get<{ count: number }>(query);
    if (!row || !Number.isSafeInteger(row.count) || row.count < 0)
      throw new Error('Deployment state unavailable');
    return row.count;
  }
}
