import { createHash } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, ModulesContainer } from '@nestjs/core';
import type { CoordinatorWorkRegistry } from '@platform/shared-kernel';

/** Reviewed composition slots, not an allowlist generated from the running app.
 * A new module/provider/factory/controller needs an explicit work-lifetime review.
 * Existing provider implementation changes still require their lifecycle tests.
 * This audit never constructs a provider, invokes a hook, or reads provider state.
 */
const PROVIDERS = `AccessPasscodeModule|class:PasscodeService|class|PasscodeService
AccessPasscodeModule|class:AccessPasscodeService|class|AccessPasscodeService
AccessPasscodeModule|class:PasscodeAttemptLimiter|class|PasscodeAttemptLimiter
AccessPasscodeModule|symbol:TerminalAuthenticator|class|PasscodeTerminalAuthenticator
AccessPasscodeModule|symbol:AccessGateReader|factory|useFactory
AuditModule|class:AuditRepository|class|AuditRepository
AuditModule|class:DbAuditRecorder|class|DbAuditRecorder
AuditModule|symbol:AuditRecorder|alias|DbAuditRecorder
AuditModule|class:AuditProjector|class|AuditProjector
AuditModule|class:AuditRetentionJob|class|AuditRetentionJob
AuditModule|class:AuditExportService|class|AuditExportService
AuditModule|class:DiagnosticSnapshotService|class|DiagnosticSnapshotService
ControlRpcModule|class:ControlApplicationRegistry|class|ControlApplicationRegistry
ControlRpcModule|class:PasscodeGuard|class|PasscodeGuard
DeploymentModule|class:DeploymentState|class|DeploymentState
RealtimeModule|class:EventsGateway|class|EventsGateway
RealtimeModule|symbol:SandboxEventBroadcaster|alias|EventsGateway
LoggingModule|symbol:RUNTIME_LOG_WRITER|factory|useFactory
LoggingModule|symbol:RUNTIME_LOG_READER|factory|useFactory
LoggingModule|class:PlatformLoggerService|class|PlatformLoggerService
LoggingModule|class:RuntimeLogLifecycle|class|RuntimeLogLifecycle
PlatformModule|symbol:Clock|class|SystemClock
PlatformModule|symbol:IdGenerator|class|UuidIdGenerator
PlatformModule|symbol:EventBus|class|InProcessEventBus
PlatformModule|symbol:Database|factory|useFactory
PlatformModule|symbol:PlatformSqlite|factory|useFactory
PlatformModule|symbol:UnitOfWork|factory|useFactory
PlatformModule|symbol:BusinessWriterAuthority|factory|useFactory
PlatformModule|symbol:CoordinatorGatewayWorkFactory|factory|useFactory
SystemModule|class:SystemSettingsService|class|SystemSettingsService
SystemModule|class:InitializationService|class|InitializationService
SystemModule|class:SystemResourcesService|class|SystemResourcesService
SystemModule|symbol:MemorySources|value|-
SystemModule|class:SystemProvidersService|class|SystemProvidersService
SystemModule|class:ProviderLogService|class|ProviderLogService
SystemModule|class:SystemVersionService|class|SystemVersionService
SystemModule|class:ConnectivityProbe|class|ConnectivityProbe
SystemModule|class:DiagnosticsService|class|DiagnosticsService
SystemModule|class:ContainerRuntimeCheck|class|ContainerRuntimeCheck
SystemModule|class:DevKvmCheck|class|DevKvmCheck
SystemModule|class:DiskSpaceCheck|class|DiskSpaceCheck
SystemModule|class:PortConflictCheck|class|PortConflictCheck
SystemModule|class:OutboundNetworkCheck|class|OutboundNetworkCheck
SystemModule|class:WsLoopbackCheck|class|WsLoopbackCheck
SystemModule|class:DataRootFsCheck|class|DataRootFsCheck
SystemModule|class:PresetImageCheck|class|PresetImageCheck
SystemModule|class:AuthHelperCheck|class|AuthHelperCheck
SystemModule|class:DockerodeProvisionAdapter|class|DockerodeProvisionAdapter
SystemModule|class:PresetImageProvisioner|factory|useFactory
SystemModule|symbol:DiagnoseChecks|factory|useFactory
UpgradeModule|class:UpgradeStore|class|UpgradeStore
UpgradeModule|class:UpgradeLedgerConnection|class|UpgradeLedgerConnection
UpgradeModule|symbol:UpgradeStoreOptions|factory|useFactory
UpgradeModule|class:UpgradeCatalog|class|UpgradeCatalog
UpgradeModule|class:UpgradeInspector|class|UpgradeInspector
UpgradeModule|symbol:UpgradeInspector|alias|UpgradeInspector
UpgradeModule|symbol:UpgradeContractService|alias|UpgradeContractService
UpgradeModule|symbol:UpgradeProjection|alias|UpgradeProjection
UpgradeModule|class:UpgradeSecurity|class|UpgradeSecurity
UpgradeModule|class:UpgradeService|class|UpgradeService
UpgradeModule|class:UpgradeOperationStore|class|UpgradeOperationStore
UpgradeModule|class:UpgradeProjection|class|UpgradeProjection
UpgradeModule|class:CoordinatorHandoff|class|CoordinatorHandoff
UpgradeModule|class:UpgradeRoleHandoffs|class|UpgradeRoleHandoffs
UpgradeModule|class:UpgradeObserver|class|UpgradeObserver
UpgradeModule|class:UpgradeProbeEvidence|class|UpgradeProbeEvidence
UpgradeModule|class:UpgradeOnlineMigration|class|UpgradeOnlineMigration
UpgradeModule|class:CoordinatorRecovery|class|CoordinatorRecovery
UpgradeModule|class:UpgradeContractStore|class|UpgradeContractStore
UpgradeModule|class:UpgradeContractBusiness|class|UpgradeContractBusiness
UpgradeModule|symbol:UpgradeContractBusiness|alias|UpgradeContractBusiness
UpgradeModule|class:UpgradeContractService|class|UpgradeContractService
UpgradeModule|symbol:JobCompletionReceipts|class|SqliteJobCompletionReceipts
UpgradeModule|symbol:ProjectReadProjection|factory|createUpgradeProjectProjection
AutomationModule|class:AutomationApplicationService|class|AutomationApplicationService
AutomationModule|class:AutomationScheduler|class|AutomationScheduler
AutomationModule|class:AutomationNotifier|class|AutomationNotifier
AutomationModule|symbol:AutomationLaunchIntents|class|SqliteAutomationLaunchIntents
AutomationModule|symbol:AutomationRepository|class|SqliteAutomationRepository
AutomationModule|symbol:AutomationRunRepository|class|SqliteAutomationRunRepository
AutomationModule|symbol:WebhookSender|class|HttpWebhookSender
AutomationModule|symbol:AutomationRunLogReader|class|FsRunLogReader
AutomationModule|symbol:AutomationProjectCleanup|class|SqliteAutomationProjectCleanup
CredentialModule|class:CredentialApplicationService|class|CredentialApplicationService
CredentialModule|class:RuntimeCredentialService|class|RuntimeCredentialService
CredentialModule|class:CredentialFacadeAdapter|class|CredentialFacadeAdapter
CredentialModule|class:CredentialRevocationFacadeAdapter|class|CredentialRevocationFacadeAdapter
CredentialModule|class:MasterKeyProvider|class|MasterKeyProvider
CredentialModule|class:KeyfileBootSweeper|class|KeyfileBootSweeper
CredentialModule|symbol:CredentialRepository|class|SqliteCredentialRepository
CredentialModule|symbol:CredentialSandboxBindingRepository|class|SqliteCredentialSandboxBindingRepository
CredentialModule|symbol:CryptoService|class|AesGcmCrypto
CredentialModule|symbol:GitAuthMaterializer|class|FsGitAuthMaterializer
CredentialModule|symbol:GitRemoteTester|class|GitLsRemoteTester
CredentialModule|symbol:RuntimeCredentialMaterializer|class|DefaultRuntimeCredentialMaterializer
CredentialModule|symbol:CredentialFacade|alias|CredentialFacadeAdapter
CredentialModule|symbol:CredentialRevocationFacade|alias|CredentialRevocationFacadeAdapter
ImageModule|class:ImageApplicationService|class|ImageApplicationService
ImageModule|class:ImageSeeder|class|ImageSeeder
ImageModule|class:ImageFacadeAdapter|class|ImageFacadeAdapter
ImageModule|class:OciImageSpecProvider|class|OciImageSpecProvider
ImageModule|symbol:ImageRepository|class|SqliteImageRepository
ImageModule|symbol:ImageManifestRepository|class|SqliteImageManifestRepository
ImageModule|symbol:ImageSpecRegistry|class|DefaultImageSpecRegistry
ImageModule|symbol:EnvSecretCipher|class|AesGcmEnvSecretCipher
ImageModule|symbol:ImageFacade|alias|ImageFacadeAdapter
ProjectModule|class:ProjectApplicationService|class|ProjectApplicationService
ProjectModule|class:CloneProjectWorkflow|class|CloneProjectWorkflow
ProjectModule|class:SyncBaselineWorkflow|class|SyncBaselineWorkflow
ProjectModule|class:ProjectMcpTools|class|ProjectMcpTools
ProjectModule|class:RetainedVolumeService|class|RetainedVolumeService
ProjectModule|class:VolumeReaper|class|VolumeReaper
ProjectModule|symbol:ProjectRepository|class|SqliteProjectRepository
ProjectModule|symbol:RetainedVolumeRepository|class|SqliteRetainedVolumeRepository
ProjectModule|symbol:RetainedVolumeStore|class|FsRetainedVolumeStore
ProjectModule|symbol:GitCloner|class|SimpleGitCloner
ProjectModule|symbol:BaselineGit|class|SimpleGitBaseline
ProjectModule|symbol:BaselineManager|class|FsBaselineDirManager
ProjectModule|symbol:ProjectFacade|class|ProjectFacadeAdapter
RuntimeModule|class:RuntimeApplicationService|class|RuntimeApplicationService
RuntimeModule|class:RuntimeInstallOrchestratorService|class|RuntimeInstallOrchestratorService
RuntimeModule|class:RuntimeEventProjector|class|RuntimeEventProjector
RuntimeModule|class:AuthSessionStore|class|AuthSessionStore
RuntimeModule|class:CodexAdapter|class|CodexAdapter
RuntimeModule|class:ClaudeCodeAdapter|class|ClaudeCodeAdapter
RuntimeModule|class:CredentialRefreshScanner|class|CredentialRefreshScanner
RuntimeModule|class:ReservedEnvNameRegistrar|class|ReservedEnvNameRegistrar
RuntimeModule|class:RuntimeSettingsReaderWriter|class|RuntimeSettingsReaderWriter
RuntimeModule|class:DefaultRuntimeCredentialStateReader|class|DefaultRuntimeCredentialStateReader
RuntimeModule|symbol:RuntimeAdapterRegistry|class|DefaultRuntimeAdapterRegistry
RuntimeModule|class:HelperContainerSession|class|HelperContainerSession
RuntimeModule|class:HostAuthHelper|class|HostAuthHelper
RuntimeModule|class:ContainerAuthHelper|class|ContainerAuthHelper
RuntimeModule|symbol:AuthHelper|factory|useFactory
RuntimeModule|symbol:PlatformReservations|value|-
RuntimeModule|symbol:RuntimeSettingsRepository|class|SqliteRuntimeSettingsRepository
RuntimeModule|symbol:RuntimeInstallationRepository|class|SqliteRuntimeInstallationRepository
RuntimeModule|symbol:RuntimeInstallOrchestrator|alias|RuntimeInstallOrchestratorService
RuntimeModule|symbol:RuntimeSettingsReader|alias|RuntimeSettingsReaderWriter
RuntimeModule|symbol:RuntimeSettingsWriter|alias|RuntimeSettingsReaderWriter
RuntimeModule|symbol:RuntimeCredentialStateReader|alias|DefaultRuntimeCredentialStateReader
SandboxModule|symbol:RuntimeBusinessAuthority|value|-
SandboxModule|class:SandboxApplicationService|class|SandboxApplicationService
SandboxModule|class:AgentTaskApplicationService|class|AgentTaskApplicationService
SandboxModule|class:ProvisionSandboxWorkflow|class|ProvisionSandboxWorkflow
SandboxModule|class:RunAgentTaskWorkflow|class|RunAgentTaskWorkflow
SandboxModule|class:SandboxMcpTools|class|SandboxMcpTools
SandboxModule|class:TaskEventHub|class|TaskEventHub
SandboxModule|class:TasksGateway|class|TasksGateway
SandboxModule|symbol:TaskEventBroadcaster|alias|TaskEventHub
SandboxModule|symbol:TaskLogStore|class|FsTaskLogStore
SandboxModule|symbol:WorkspaceArtifactReader|class|FsWorkspaceArtifactReader
SandboxModule|symbol:SandboxRepository|class|SqliteSandboxRepository
SandboxModule|symbol:AgentTaskRepository|class|SqliteAgentTaskRepository
SandboxModule|symbol:AgentTaskStartIntents|class|SqliteAgentTaskStartIntents
SandboxModule|symbol:SandboxCreateIntents|class|SqliteSandboxCreateIntents
SandboxModule|symbol:SandboxAdmissionIntents|class|SqliteSandboxAdmissionIntents
SandboxModule|symbol:SandboxStartupProgressStore|class|SqliteSandboxStartupProgress
SandboxModule|symbol:SandboxStopIntents|class|SqliteSandboxStopIntents
SandboxModule|symbol:ResourceAllocationRepository|class|SqliteResourceAllocationRepository
SandboxModule|symbol:HostCapacityProbe|class|OsHostCapacityProbe
SandboxModule|class:SchedulerQueue|class|SchedulerQueue
SandboxModule|class:ResourceAllocator|class|ResourceAllocator
SandboxModule|class:QuotaReconciler|class|QuotaReconciler
SandboxModule|symbol:WorkspacePreparer|class|FsWorkspacePreparer
SandboxModule|symbol:DockerClient|factory|createDockerClient
SandboxModule|class:SandboxHealthMonitor|class|SandboxHealthMonitor
SandboxModule|symbol:SandboxProviderRegistry|factory|useFactory
SandboxModule|symbol:SandboxPtyPort|class|SandboxPtyAdapter
SandboxModule|symbol:SandboxExecPort|class|SandboxExecAdapter
SandboxModule|symbol:SandboxFacade|class|SandboxFacadeAdapter
SandboxModule|symbol:AutomationTaskLauncher|class|AutomationTaskLauncherAdapter
SandboxModule|class:SandboxEventProjector|class|SandboxEventProjector
SandboxModule|class:CredentialRevokedHandler|class|CredentialRevokedHandler
TerminalModule|class:TerminalSessionService|class|TerminalSessionService
TerminalModule|symbol:TerminalBookmarks|class|SqliteTerminalBookmarks
TerminalModule|symbol:TerminalBookmarkCleanup|alias|SqliteTerminalBookmarks
TerminalModule|class:TerminalGateway|class|TerminalGateway
TerminalModule|class:WaitingInputService|class|WaitingInputService
TerminalModule|symbol:WaitingInputObserver|class|WaitingInputDetector
TerminalModule|symbol:WaitingInputSettings|factory|waitingInputSettings
TerminalModule|symbol:WaitingInputQueryPort|alias|WaitingInputService
TerminalModule|symbol:AgentSessionBootstrap|alias|TerminalSessionService
AppModule|app-guard|class|PasscodeGuard`;
const CONTROLLERS = `AccessPasscodeModule|class:AccessController|class|AccessController
AuditModule|class:AuditController|class|AuditController
ControlRpcModule|class:ControlRpcController|class|ControlRpcController
ControlRpcModule|class:ApplicationOperationController|class|ApplicationOperationController
DeploymentModule|class:DeploymentController|class|DeploymentController
SystemModule|class:HealthController|class|HealthController
SystemModule|class:SystemController|class|SystemController
UpgradeModule|class:UpgradeController|class|UpgradeController
UpgradeModule|class:UpgradeInternalController|class|UpgradeInternalController
UpgradeModule|class:UpgradeContractInternalController|class|UpgradeContractInternalController
UpgradeModule|class:UpgradeInspectionController|class|UpgradeInspectionController
UpgradeModule|class:UpgradeContractBusinessController|class|UpgradeContractBusinessController
AutomationModule|class:ProjectAutomationController|class|ProjectAutomationController
AutomationModule|class:AutomationController|class|AutomationController
CredentialModule|class:CredentialController|class|CredentialController
ImageModule|class:ImageController|class|ImageController
ProjectModule|class:ProjectController|class|ProjectController
ProjectModule|class:RetainedVolumeController|class|RetainedVolumeController
RuntimeModule|class:RuntimeController|class|RuntimeController
SandboxModule|class:SandboxController|class|SandboxController
SandboxModule|class:AgentTaskController|class|AgentTaskController
SandboxModule|class:ProviderController|class|ProviderController`;
const FRAMEWORK = `InternalCoreModule|class:Reflector|class|Reflector
InternalCoreModule|string:Reflector|alias|Reflector
InternalCoreModule|string:REQUEST|factory|noop
InternalCoreModule|string:INQUIRER|factory|noop
InternalCoreModule|class:ExternalContextCreator|factory|useFactory
InternalCoreModule|class:ModulesContainer|factory|useFactory
InternalCoreModule|class:HttpAdapterHost|factory|useFactory
InternalCoreModule|class:LazyModuleLoader|factory|lazyModuleLoaderFactory
InternalCoreModule|class:SerializedGraph|factory|useFactory
DiscoveryModule|class:MetadataScanner|class|MetadataScanner
DiscoveryModule|class:DiscoveryService|class|DiscoveryService`;

const BUSINESS_MODULES = [
  'AppModule',
  'AccessPasscodeModule',
  'AuditModule',
  'ControlRpcModule',
  'DeploymentModule',
  'RealtimeModule',
  'LoggingModule',
  'PlatformModule',
  'SystemModule',
  'UpgradeModule',
  'AutomationModule',
  'CredentialModule',
  'ImageModule',
  'ProjectModule',
  'RuntimeModule',
  'SandboxModule',
  'TerminalModule',
] as const;
const MODULES = new Set<string>([...BUSINESS_MODULES, 'InternalCoreModule', 'DiscoveryModule']);
const FORBIDDEN = new Set([
  'McpModule',
  'McpFeatureModule',
  'McpSseService',
  'McpStreamableHttpService',
  'SsePingService',
  'StdioService',
  'RuntimeOwnerModule',
  'RuntimeReconciler',
  'AioSandboxProvider',
  'BoxliteSandboxProvider',
  'DockerSelfNetworkCheck',
]);
const NORMAL_WORKERS = [
  'automation.notifier',
  'automation.scheduler',
  'credential.boot-sweep',
  'platform.audit-retention',
  'platform.diagnostics',
  'platform.events',
  'platform.events-gateway',
  'platform.http',
  'platform.image-provision',
  'platform.image-seed',
  'platform.logging',
  'project.baseline',
  'project.clone',
  'project.volume-reaper',
  'runtime.auth',
  'runtime.helper-preheat',
  'runtime.refresh',
  'sandbox.automation-cleanup',
  'sandbox.credential-cleanup',
  'sandbox.health',
  'sandbox.operations',
  'sandbox.project-cleanup',
  'sandbox.provision',
  'sandbox.quota',
  'sandbox.task-pump',
  'sandbox.task-recovery',
  'sandbox.tasks-gateway',
  'terminal.gateway',
  'terminal.waiting-input',
  'upgrade.contract',
  'upgrade.coordinator-recovery',
  'upgrade.observer',
  'upgrade.operations',
  'upgrade.projection',
] as const;

export interface CoordinatorWorkerManifestOptions {
  prepared: boolean;
  dormant?: boolean;
}
export function expectedCoordinatorWorkers(options: CoordinatorWorkerManifestOptions): string[] {
  return [
    ...NORMAL_WORKERS,
    ...(options.dormant ? [] : ['platform.writer-renewal']),
    ...(options.prepared ? ['platform.prepared-management'] : []),
  ].sort();
}

interface Wrapper {
  token: unknown;
  metatype?: unknown;
  inject?: unknown[] | null;
  isAlias?: boolean;
  host?: { metatype?: unknown };
}
interface Slot {
  host: string;
  slot: string;
  kind: string;
  implementation: string;
}
function parseSlots(input: string): Slot[] {
  return input.split('\n').map((line) => {
    const [host, slot, kind, implementation] = line.split('|');
    return { host, slot, kind, implementation };
  });
}
const PROVIDER_SLOTS = parseSlots(PROVIDERS + '\n' + FRAMEWORK);
const CONTROLLER_SLOTS = parseSlots(CONTROLLERS);
function name(value: unknown): string {
  return typeof value === 'function' ? value.name : '';
}
function tokenName(token: unknown): string {
  if (typeof token === 'function') return 'class:' + token.name;
  if (typeof token === 'symbol') return 'symbol:' + (token.description ?? '');
  if (typeof token === 'string') {
    if (/^APP_GUARD \(UUID: [a-zA-Z0-9-]+\)$/.test(token)) return 'app-guard';
    return 'string:' + token;
  }
  return 'unsupported';
}
function slotMatches(wrapper: Wrapper, slot: Slot, providers: readonly Wrapper[]): boolean {
  if (name(wrapper.host?.metatype) !== slot.host || tokenName(wrapper.token) !== slot.slot)
    return false;
  if (slot.kind === 'alias') {
    if (!wrapper.isAlias || wrapper.inject?.length !== 1) return false;
    const dependency = wrapper.inject[0];
    return providers.some(
      (target) =>
        target.token === dependency &&
        !target.isAlias &&
        name(target.metatype) === slot.implementation &&
        name(target.host?.metatype) === slot.host,
    );
  }
  if (wrapper.isAlias) return false;
  if (slot.kind === 'value') return wrapper.metatype == null && wrapper.inject == null;
  if (name(wrapper.metatype) !== slot.implementation) return false;
  return slot.kind === 'factory' ? Array.isArray(wrapper.inject) : wrapper.inject == null;
}

/** Current Coordinator routes contain only finite @Res() SSE handlers, whose
 * actual Promises and background producers are tracked separately. A permanent
 * Nest @Sse() Observable requires a distinct unsubscribe/teardown contract before
 * it can be certified. Never infer that contract from an approved class name.
 * Inspect descriptors without invoking getters, hooks, or route methods.
 */
function hasUnreviewedSseController(metatype: unknown): boolean {
  if (typeof metatype !== 'function') throw new Error('CONTROLLER_TYPE_UNKNOWN');
  let prototype: unknown = metatype.prototype;
  const seen = new Set<PropertyKey>();
  let depth = 0,
    methods = 0;
  while (prototype != null && prototype !== Object.prototype) {
    if (++depth > 16 || (typeof prototype !== 'object' && typeof prototype !== 'function'))
      throw new Error('CONTROLLER_PROTOTYPE_UNKNOWN');
    const keys = Reflect.ownKeys(prototype);
    if (keys.length > 256 || (methods += keys.length) > 1024)
      throw new Error('CONTROLLER_METHOD_BOUND_EXCEEDED');
    for (const key of keys) {
      if (key === 'constructor' || seen.has(key)) continue;
      seen.add(key);
      const method: unknown = Object.getOwnPropertyDescriptor(prototype, key)?.value;
      if (typeof method === 'function' && Reflect.hasMetadata(SSE_METADATA, method)) return true;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}

/** Bounded actual Nest DI inventory plus the separately registered actual work
 * manifest. Missing/unknown/duplicate composition permanently invalidates this
 * process's retirement coverage; the service itself may continue operating.
 */
export function sealCoordinatorWorkerManifest(
  app: Pick<INestApplicationContext, 'get'>,
  registry: CoordinatorWorkRegistry,
  options: CoordinatorWorkerManifestOptions,
): { qualified: boolean; manifestDigest: string; unreviewed: string[] } {
  const expected = expectedCoordinatorWorkers(options);
  const unreviewed: string[] = [];
  const reject = (value: string): void => {
    if (unreviewed.length < 32) unreviewed.push(value.slice(0, 180));
    registry.invalidateCoverage();
  };
  try {
    if (options.dormant && !options.prepared) reject('invalid-role-scope');
    const discovery = app.get(DiscoveryService);
    const modules = app.get(ModulesContainer);
    const providers: readonly Wrapper[] = discovery.getProviders();
    const controllers: readonly Wrapper[] = discovery.getControllers();
    if (modules.size !== MODULES.size || providers.length > 512 || controllers.length > 128) {
      reject('inventory-bound-or-module-count');
    } else {
      const moduleNames = new Set<string>();
      for (const module of modules.values()) {
        const host = name(module.metatype);
        if (!MODULES.has(host) || FORBIDDEN.has(host) || moduleNames.has(host))
          reject('module:' + host);
        moduleNames.add(host);
        // Discovery does not include enhancers/middleware. No such independent
        // construction slot has been reviewed in the Coordinator composition.
        if (module.injectables.size || module.middlewares.size) reject('enhancer:' + host);
      }
      for (const host of MODULES) if (!moduleNames.has(host)) reject('missing-module:' + host);
      const seen = new Set<string>();
      const audit = (wrappers: readonly Wrapper[], slots: readonly Slot[], kind: string): void => {
        for (const wrapper of wrappers) {
          const host = name(wrapper.host?.metatype),
            token = tokenName(wrapper.token);
          const key = kind + '|' + host + '|' + token;
          if (seen.has(key)) reject('duplicate:' + key);
          seen.add(key);
          if (kind === 'controller' && hasUnreviewedSseController(wrapper.metatype))
            reject('sse-controller-lifecycle-unreviewed:' + key);
          if (FORBIDDEN.has(name(wrapper.metatype))) {
            reject('forbidden:' + key);
            continue;
          }
          const core =
            kind === 'provider' &&
            MODULES.has(host) &&
            ((wrapper.token === wrapper.host?.metatype && wrapper.metatype === wrapper.token) ||
              (token === 'class:ModuleRef' && name(wrapper.metatype) === 'ModuleRef') ||
              (token === 'class:ApplicationConfig' && wrapper.metatype == null));
          if (!core && !slots.some((slot) => slotMatches(wrapper, slot, providers)))
            reject('unreviewed:' + key);
        }
      };
      audit(providers, PROVIDER_SLOTS, 'provider');
      audit(controllers, CONTROLLER_SLOTS, 'controller');
    }
  } catch {
    reject('inventory-unavailable');
  }
  registry.seal(expected);
  const manifestDigest =
    'sha256:' +
    createHash('sha256')
      .update(
        JSON.stringify({
          version: 1,
          providers: PROVIDER_SLOTS,
          controllers: CONTROLLER_SLOTS,
          modules: [...MODULES].sort(),
          expected,
        }),
      )
      .digest('hex');
  return { qualified: registry.snapshot().coverageComplete, manifestDigest, unreviewed };
}
