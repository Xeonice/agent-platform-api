import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  AuthChallengeDto,
  AuthStatusResult,
  MaskedCredentialResult,
  RuntimeDto,
  RuntimeSettingsDto,
} from '@platform/contracts';
import { RuntimeApplicationService } from '../../application/runtime-application.service';
import {
  AuthChallengeResponseDto,
  AuthStatusResultResponseDto,
  BeginAuthDto,
  CompleteAuthDto,
  MaskedCredentialResultResponseDto,
  RuntimeResponseDto,
  RuntimeSettingsResponseDto,
  SetAuthModeDto,
  SubmitSecretDto,
} from './dto/runtime.dto';

/**
 * REST shell for the runtime auth/credential endpoints (docs/backend/27 §4, 05 §3).
 * ALL endpoints are sandbox-DIMENSIONLESS (05 §2 decision A). Runtime credentials are
 * NOT registered to MCP (a coerced upper agent must not revoke your credential or
 * flip your effective mode, 27 §7). The global `/api` prefix is added in main.ts.
 */
@ApiTags('runtime')
@Controller('runtimes')
export class RuntimeController {
  constructor(private readonly app: RuntimeApplicationService) {}

  @Get()
  @ApiOperation({ summary: 'List runtimes with aggregated credential status (no N+1)' })
  @ApiOkResponse({ type: RuntimeResponseDto, isArray: true })
  list(): Promise<RuntimeDto[]> {
    return this.app.listRuntimes();
  }

  @Get(':rt/credentials/status')
  @ApiOperation({ summary: 'Single-runtime credential status (never returns plaintext)' })
  @ApiOkResponse({ type: RuntimeResponseDto })
  status(@Param('rt') rt: string): Promise<RuntimeDto> {
    return this.app.getCredentialStatus(rt);
  }

  @Post(':rt/auth/begin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start an interactive login in the auth helper (no sandbox)' })
  @ApiOkResponse({ type: AuthChallengeResponseDto })
  beginAuth(@Param('rt') rt: string, @Body() dto: BeginAuthDto): Promise<AuthChallengeDto> {
    return this.app.beginAuth(rt, dto.method);
  }

  @Get(':rt/auth/status')
  @ApiOperation({ summary: 'Poll a device-code login (pending/success/expired/error)' })
  @ApiOkResponse({ type: AuthStatusResultResponseDto })
  pollStatus(
    @Param('rt') rt: string,
    @Query('challengeRef') challengeRef: string,
  ): Promise<AuthStatusResult> {
    return this.app.pollAuthStatus(rt, challengeRef);
  }

  @Post(':rt/auth/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Submit the pasted setup-token code (written to helper stdin)' })
  @ApiOkResponse({ type: MaskedCredentialResultResponseDto })
  completeAuth(
    @Param('rt') rt: string,
    @Body() dto: CompleteAuthDto,
  ): Promise<MaskedCredentialResult> {
    return this.app.completeAuth(rt, dto.challengeRef, dto.pastedText);
  }

  @Post(':rt/credentials/secret')
  @HttpCode(200)
  @ApiOperation({ summary: 'Store an api-key directly (short-circuit, no helper/pty)' })
  @ApiOkResponse({ type: MaskedCredentialResultResponseDto })
  submitSecret(
    @Param('rt') rt: string,
    @Body() dto: SubmitSecretDto,
  ): Promise<MaskedCredentialResult> {
    return this.app.submitSecret(rt, dto.secret);
  }

  @Put(':rt/auth-mode')
  @ApiOperation({ summary: 'Switch the effective mode (account|api-key); 409 if unconfigured' })
  @ApiOkResponse({ type: RuntimeSettingsResponseDto })
  setAuthMode(@Param('rt') rt: string, @Body() dto: SetAuthModeDto): Promise<RuntimeSettingsDto> {
    return this.app.setAuthMode(rt, dto.method);
  }

  @Delete(':rt/credentials/:credentialId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke a runtime credential (restarts bound live sandboxes)' })
  @ApiNoContentResponse()
  revoke(@Param('rt') rt: string, @Param('credentialId') credentialId: string): Promise<void> {
    return this.app.revokeCredential(rt, credentialId);
  }
}
