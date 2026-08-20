import { Global, Module } from '@nestjs/common';
import {
  RUNTIME_ADAPTER_REGISTRY,
  RUNTIME_SETTINGS_READER,
  RUNTIME_SETTINGS_WRITER,
} from '@platform/contracts';
import { RUNTIME_SETTINGS_REPOSITORY } from '../domain/repositories/runtime-settings.repository';
import { RuntimeApplicationService } from '../application/runtime-application.service';
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
    AuthSessionStore,
    CodexAdapter,
    ClaudeCodeAdapter,
    CredentialRefreshScanner,
    RuntimeSettingsReaderWriter,
    { provide: RUNTIME_ADAPTER_REGISTRY, useClass: DefaultRuntimeAdapterRegistry },
    { provide: AUTH_HELPER, useClass: HostAuthHelper },
    { provide: RUNTIME_SETTINGS_REPOSITORY, useClass: SqliteRuntimeSettingsRepository },
    { provide: RUNTIME_SETTINGS_READER, useExisting: RuntimeSettingsReaderWriter },
    { provide: RUNTIME_SETTINGS_WRITER, useExisting: RuntimeSettingsReaderWriter },
  ],
  exports: [
    RuntimeApplicationService,
    RUNTIME_ADAPTER_REGISTRY,
    RUNTIME_SETTINGS_READER,
    RUNTIME_SETTINGS_WRITER,
  ],
})
export class RuntimeModule {}
