import { Global, Module } from '@nestjs/common';
import { PROJECT_FACADE } from '@platform/contracts';
import { PROJECT_REPOSITORY } from '../domain/repositories/project.repository';
import { RETAINED_VOLUME_REPOSITORY } from '../domain/repositories/retained-volume.repository';
import { RETAINED_VOLUME_STORE } from '../domain/ports/retained-volume-store.port';
import { GIT_CLONER } from '../domain/ports/git-cloner.port';
import { BASELINE_GIT } from '../domain/ports/baseline-git.port';
import { BASELINE_MANAGER } from '../domain/ports/baseline-manager.port';
import { ProjectApplicationService } from '../application/project-application.service';
import { CloneProjectWorkflow } from '../application/clone-project.workflow';
import { SyncBaselineWorkflow } from '../application/sync-baseline.workflow';
import { ProjectFacadeAdapter } from '../application/project-facade.adapter';
import { SqliteProjectRepository } from '../infrastructure/persistence/sqlite/project.repository.impl';
import { SqliteRetainedVolumeRepository } from '../infrastructure/persistence/sqlite/retained-volume.repository.impl';
import { FsRetainedVolumeStore } from '../infrastructure/volume/fs-retained-volume.store';
import { VolumeReaper } from '../application/volume.reaper';
import { RetainedVolumeService } from '../application/retained-volume.service';
import { SimpleGitCloner } from '../infrastructure/git/git-cloner';
import { SimpleGitBaseline } from '../infrastructure/git/baseline-git';
import { FsBaselineDirManager } from '../infrastructure/baseline/baseline-dir.manager';
import { ProjectController } from './http/project.controller';
import { RetainedVolumeController } from './http/retained-volume.controller';
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
  controllers: [ProjectController, RetainedVolumeController],
  providers: [
    ProjectApplicationService,
    CloneProjectWorkflow,
    SyncBaselineWorkflow,
    ProjectMcpTools,
    RetainedVolumeService,
    VolumeReaper,
    { provide: PROJECT_REPOSITORY, useClass: SqliteProjectRepository },
    { provide: RETAINED_VOLUME_REPOSITORY, useClass: SqliteRetainedVolumeRepository },
    { provide: RETAINED_VOLUME_STORE, useClass: FsRetainedVolumeStore },
    { provide: GIT_CLONER, useClass: SimpleGitCloner },
    { provide: BASELINE_GIT, useClass: SimpleGitBaseline },
    { provide: BASELINE_MANAGER, useClass: FsBaselineDirManager },
    { provide: PROJECT_FACADE, useClass: ProjectFacadeAdapter },
  ],
  exports: [ProjectApplicationService, RetainedVolumeService, PROJECT_FACADE],
})
export class ProjectModule {}
