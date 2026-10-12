import { Global, Module } from '@nestjs/common';
import { JOB_COMPLETION_RECEIPTS, SqliteJobCompletionReceipts } from '@platform/sandbox';
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
import { UpgradeOnlineMigration } from './upgrade-online-migration';
import { CoordinatorRecovery } from './coordinator-recovery';

@Global()
@Module({
  imports: [ControlRpcModule],
  controllers: [UpgradeController, UpgradeInternalController],
  providers: [
    UpgradeStore,
    UpgradeCatalog,
    UpgradeInspector,
    UpgradeSecurity,
    UpgradeService,
    CoordinatorHandoff,
    UpgradeRoleHandoffs,
    UpgradeObserver,
    UpgradeOnlineMigration,
    CoordinatorRecovery,
    { provide: JOB_COMPLETION_RECEIPTS, useClass: SqliteJobCompletionReceipts },
  ],
  exports: [UpgradeService, UpgradeStore, JOB_COMPLETION_RECEIPTS],
})
export class UpgradeModule {}
