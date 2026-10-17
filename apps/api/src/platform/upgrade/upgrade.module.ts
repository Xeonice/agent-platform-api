import { Global, Module } from '@nestjs/common';
import { JOB_COMPLETION_RECEIPTS, SqliteJobCompletionReceipts } from '@platform/sandbox';
import { PROJECT_READ_PROJECTION } from '@platform/project';
import { UpgradeSecurity } from '../access-passcode/upgrade-security.service';
import { UpgradeCatalog } from './upgrade-catalog';
import { UpgradeController, UpgradeInternalController } from './upgrade.controller';
import { UpgradeInspector } from './upgrade-inspector';
import { UpgradeService } from './upgrade-service';
import { UpgradeStore } from './upgrade-store';
import { ControlRpcModule } from '../control-rpc/control-rpc.module';
import { CoordinatorHandoff } from './coordinator-handoff';
import { UpgradeRoleHandoffs } from './upgrade-role-handoffs';
import { UpgradeObserver } from './upgrade-observer';
import { UpgradeProbeEvidence } from './upgrade-probe-evidence';
import { UpgradeOnlineMigration } from './upgrade-online-migration';
import { CoordinatorRecovery } from './coordinator-recovery';
import { createUpgradeProjectProjection } from './upgrade-project-projection';
import { UpgradeContractStore } from './upgrade-contract-store';
import { UpgradeContractService } from './upgrade-contract-service';
import { UpgradeContractInternalController } from './upgrade.controller';
import { UpgradeOperationStore } from './upgrade-operation-store';
import { UpgradeProjection } from './upgrade-projection';

@Global()
@Module({
  imports: [ControlRpcModule],
  controllers: [UpgradeController, UpgradeInternalController, UpgradeContractInternalController],
  providers: [
    UpgradeStore,
    UpgradeCatalog,
    UpgradeInspector,
    UpgradeSecurity,
    UpgradeService,
    UpgradeOperationStore,
    UpgradeProjection,
    CoordinatorHandoff,
    UpgradeRoleHandoffs,
    UpgradeObserver,
    UpgradeProbeEvidence,
    UpgradeOnlineMigration,
    CoordinatorRecovery,
    UpgradeContractStore,
    UpgradeContractService,
    { provide: JOB_COMPLETION_RECEIPTS, useClass: SqliteJobCompletionReceipts },
    {
      provide: PROJECT_READ_PROJECTION,
      inject: [UpgradeOnlineMigration],
      useFactory: createUpgradeProjectProjection,
    },
  ],
  exports: [UpgradeService, UpgradeStore, JOB_COMPLETION_RECEIPTS, PROJECT_READ_PROJECTION],
})
export class UpgradeModule {}
