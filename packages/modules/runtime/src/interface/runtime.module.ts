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
import { ReservedEnvNameRegistrar } from '../infrastructure/registry/reserved-env.registrar';
import { HostAuthHelper } from '../infrastructure/helper/host-auth-helper';
import { ContainerAuthHelper } from '../infrastructure/helper/container-auth-helper';
import { HelperContainerSession } from '../infrastructure/helper/helper-container.session';
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
 * (host form default), the settings repo, the codex refresh scanner, and the
 * `ReservedEnvNameRegistrar` that folds every registered adapter's declared env
 * names into the platform blacklist once ALL modules have registered (05 §4.1).
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
    ReservedEnvNameRegistrar,
    RuntimeSettingsReaderWriter,
    DefaultRuntimeCredentialStateReader,
    { provide: RUNTIME_ADAPTER_REGISTRY, useClass: DefaultRuntimeAdapterRegistry },
    HelperContainerSession,
    HostAuthHelper,
    ContainerAuthHelper,
    {
      /**
       * 形态二选一（11 §1.1 的 `auth.helper.mode`，默认 `container`）。
       *
       * ⚠️⚠️ **默认必须是 container。** 宿主形态要求「后端进程所在环境自带两个 CLI」——
       * 而出厂部署形态是 `docker compose up`，api 跑在 `node:22-bookworm-slim` 里,
       * 那张镜像**没有也不该有**这两个 CLI（装进去就是与沙箱两条独立升级线，11 §1.1）。
       * ⇒ 此前这里硬接 `HostAuthHelper`，于是每一个容器部署点「帐号登录」必然失败，
       * 报的还是一句「多半是这个 CLI 在这台机器上没能正常启动」——
       * ⛔ 而真相是它压根没装。2026-09-22 在一台真机上复现后改掉。
       *
       * ⚠️ `host` 仍然保留，且**不是遗留代码**：裸机 systemd 部署（11 §1.3）没有容器
       * 运行时，那一档只能走宿主 CLI。
       */
      provide: AUTH_HELPER,
      inject: [ContainerAuthHelper, HostAuthHelper],
      useFactory: (container: ContainerAuthHelper, host: HostAuthHelper): unknown =>
        (process.env['AUTH_HELPER_MODE'] ?? 'container') === 'host' ? host : container,
    },
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
    // ⚠️ 导出它**只为一个消费方**：`platform/system` 的 `AuthHelperCheck` 要读
    //    helper 的就绪状态（11 §1.1「不要等用户点登录才失败」）。
    // ⛔ 2026-09-22 漏了这一行 ⇒ api **起不来**（Nest 解析不出
    //    `AuthHelperCheck` 的第 0 个参数）。而单测一条都没红：它们把 session
    //    mock 掉了，**DI 接线从来没被执行过**。这类漏接只有真正把模块装起来才看得见。
    HelperContainerSession,
  ],
})
export class RuntimeModule {}
