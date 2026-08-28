// Public surface of the credential context consumed by the app assembly.
export { CredentialModule } from './interface/credential.module';
export { CredentialApplicationService } from './application/credential-application.service';
export { RuntimeCredentialService } from './application/runtime-credential.service';
export type {
  StoreRuntimeCredentialInput,
  RuntimeCredentialView,
  RuntimeCredentialSummaryData,
  RuntimeRefreshDue,
} from './application/runtime-credential.service';
export { credentials } from './infrastructure/persistence/schema/credential.sqlite';
export { credentialSandboxBindings } from './infrastructure/persistence/schema/credential-sandbox-binding.sqlite';
export { CREDENTIAL_SANDBOX_BINDING_REPOSITORY } from './domain/repositories/credential-sandbox-binding.repository';
export type { CredentialSandboxBindingRepository } from './domain/repositories/credential-sandbox-binding.repository';
export type { CredentialSandboxBinding } from './domain/entities/credential-sandbox-binding.entity';
export type {
  RuntimeSecretPayload,
  RuntimeCredentialFileMaterial,
  MaterializedRuntimeCredential,
  MaterializedRefreshCredential,
} from './domain/ports/runtime-credential-materializer.port';
export { MissingPlatformAuthFileError } from './domain/ports/runtime-credential-materializer.port';
// 领域事件类 —— 供平台级 `AuditProjector` 判别（理由见 sandbox 包同一处注释）。
export {
  CredentialStored,
  CredentialRevoked,
  CredentialInjected,
} from './domain/events/credential-events';
