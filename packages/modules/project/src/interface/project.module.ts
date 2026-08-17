import { Global, Module } from '@nestjs/common';
import { PROJECT_FACADE } from '@platform/contracts';
import { PROJECT_REPOSITORY } from '../domain/repositories/project.repository';
import { GIT_CLONER } from '../domain/ports/git-cloner.port';
import { BASELINE_MANAGER } from '../domain/ports/baseline-manager.port';
import { ProjectApplicationService } from '../application/project-application.service';
import { CloneProjectWorkflow } from '../application/clone-project.workflow';
import { ProjectFacadeAdapter } from '../application/project-facade.adapter';
import { SqliteProjectRepository } from '../infrastructure/persistence/sqlite/project.repository.impl';
import { SimpleGitCloner } from '../infrastructure/git/git-cloner';
import { FsBaselineDirManager } from '../infrastructure/baseline/baseline-dir.manager';
import { ProjectController } from './http/project.controller';
import { ProjectMcpTools } from './mcp/project.mcp-tools';

/**
 * Composition root for the project context (01) — the ONE place ports are bound.
 * @Global so the cross-context `PROJECT_FACADE` reaches the sandbox context
 * without a package cycle (the facade token is a contracts symbol; the impl is
 * wired here). Registers the clone workflow (background orchestrator + startup
 * interrupted-clone reaper).
 */
@Global()
@Module({
  controllers: [ProjectController],
  providers: [
    ProjectApplicationService,
    CloneProjectWorkflow,
    ProjectMcpTools,
    { provide: PROJECT_REPOSITORY, useClass: SqliteProjectRepository },
    { provide: GIT_CLONER, useClass: SimpleGitCloner },
    { provide: BASELINE_MANAGER, useClass: FsBaselineDirManager },
    { provide: PROJECT_FACADE, useClass: ProjectFacadeAdapter },
  ],
  exports: [ProjectApplicationService, PROJECT_FACADE],
})
export class ProjectModule {}
