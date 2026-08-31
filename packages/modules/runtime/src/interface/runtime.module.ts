import { Global, Module } from '@nestjs/common';
import {
  RUNTIME_ADAPTER_REGISTRY,
  RUNTIME_CREDENTIAL_STATE_READER,
  RUNTIME_INSTALL_ORCHESTRATOR,
  RUNTIME_SETTINGS_READER,
  RUNTIME_SETTINGS_WRITER,
} from '@platform/contracts';
import { RUNTIME_SETTINGS_REPOSITORY } from '../domain/repositories/runtime-settings.repository';
import { RUNTIME_INSTALLATION_REPOSITORY } from '../domain/repositories/runtime-installation.repository';
import { RuntimeInstallOrchestratorService } from '../application/runtime-install.orchestrator';
import { RuntimeEventProjector } from '../application/runtime-event.projector';
import { SqliteRuntimeInstallationRepository } from '../infrastructure/persistence/sqlite/runtime-installation.repository.impl';
import { RuntimeApplicationService } from '../application/runtime-application.service';
import { DefaultRuntimeCredentialStateReader } from '../application/runtime-credential-state.reader';
import { AuthSessionStore } from '../application/auth-session.store';
import { AUTH_HELPER } from '../domain/ports/auth-helper.port';
import { CodexAdapter } from '../infrastructure/adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../infrastructure/adapters/claude-code/claude-code.adapter';
import { DefaultRuntimeAdapterRegistry } from '../infrastructure/registry/runtime-adapter.registry';
import { HostAuthHelper } from '../infrastructure/helper/host-auth-helper';
import { SqliteRuntimeSettingsRepository } from '../infrastructure/persistence/sqlite/runtime-settings.repository.impl';
import { RuntimeSettingsReaderWriter } from '../infrastructure/settings/runtime-settings.reader';
import { CredentialRefreshScanner } from '../infrastructure/refresh/credential-refresh.scanner';
import { RuntimeController } from './http/runtime.controller';

/**
 * Composition root for the runtime context (01, 05, 27 §4). @Global so the contracts
 * `RUNTIME_SETTINGS_READER` / `RUNTIME_SETTINGS_WRITER` reach the credential context
 * (which reads the effective mode + writes `runtime_settings` in the store tx) with
 * NO package cycle — the coupling is via contracts tokens only. Registers the two
 * built-in adapters against the open `RUNTIME_ADAPTER_REGISTRY`, the auth helper
 * (host form default), the settings repo, and the codex refresh scanner.
 */
@Global()
@Module({
  controllers: [RuntimeController],
  providers: [
    RuntimeApplicationService,
    RuntimeInstallOrchestratorService,
    RuntimeEventProjector,
    AuthSessionStore,
    CodexAdapter,
    ClaudeCodeAdapter,
    CredentialRefreshScanner,
    RuntimeSettingsReaderWriter,
    DefaultRuntimeCredentialStateReader,
    { provide: RUNTIME_ADAPTER_REGISTRY, useClass: DefaultRuntimeAdapterRegistry },
    { provide: AUTH_HELPER, useClass: HostAuthHelper },
    { provide: RUNTIME_SETTINGS_REPOSITORY, useClass: SqliteRuntimeSettingsRepository },
    { provide: RUNTIME_INSTALLATION_REPOSITORY, useClass: SqliteRuntimeInstallationRepository },
    { provide: RUNTIME_INSTALL_ORCHESTRATOR, useExisting: RuntimeInstallOrchestratorService },
    { provide: RUNTIME_SETTINGS_READER, useExisting: RuntimeSettingsReaderWriter },
    { provide: RUNTIME_SETTINGS_WRITER, useExisting: RuntimeSettingsReaderWriter },
    // 03 §8.2 行 2：automation 每分钟问一次「这个 runtime 有没有能用的凭证」。
    { provide: RUNTIME_CREDENTIAL_STATE_READER, useExisting: DefaultRuntimeCredentialStateReader },
  ],
  exports: [
    RuntimeApplicationService,
    RUNTIME_ADAPTER_REGISTRY,
    RUNTIME_INSTALL_ORCHESTRATOR,
    RUNTIME_SETTINGS_READER,
    RUNTIME_SETTINGS_WRITER,
    RUNTIME_CREDENTIAL_STATE_READER,
  ],
})
export class RuntimeModule {}
