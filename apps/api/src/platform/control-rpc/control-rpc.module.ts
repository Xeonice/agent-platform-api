import {
  Controller,
  Get,
  Post,
  Req,
  Res,
  Param,
  Injectable,
  Module,
  Inject,
  UnauthorizedException,
  BadRequestException,
  HttpException,
  StreamableFile,
  type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import {
  PATH_METADATA,
  METHOD_METADATA,
  HTTP_CODE_METADATA,
  ROUTE_ARGS_METADATA,
  PARAMTYPES_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import express from 'express';
import type { Request, Response } from 'express';
import { PassThrough } from 'node:stream';
import { createHash, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { z, ZodTypeAny } from 'zod';
import { zodToOpenAPI, createZodDto } from 'nestjs-zod';
import { ApiOkResponse } from '@nestjs/swagger';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import { withRuntimeBusinessAuthority } from '@platform/sandbox';
import { PLATFORM_SQLITE } from '../persistence/platform.module';
import { PasscodeGuard } from '../access-passcode/passcode.guard';
import { platformValidationPipe } from '../../bootstrap/validation.pipe';
import {
  ApplicationRequestSchema,
  ApplicationOperationSchema,
  type ApplicationCatalog,
  type ApplicationFrame,
  type ApplicationRequest,
  type ApplicationRoute,
} from './control-rpc.contract';

const CONTROLLERS = new Set([
  'ProjectController',
  'RetainedVolumeController',
  'SandboxController',
  'AgentTaskController',
  'ProviderController',
  'CredentialController',
  'RuntimeController',
  'ImageController',
  'AutomationController',
  'ProjectAutomationController',
  'HealthController',
  'SystemController',
  'AuditController',
  'AccessController',
  'DeploymentController',
  'UpgradeController',
  'ApplicationOperationController',
]);
const TOOLS = new Set(['ProjectMcpTools', 'SandboxMcpTools']);
const SENSITIVE =
  /(?:AccessController|\.setAccessPasscode|\.access$|\.storeGitCredential|\.submitSecret|\.completeAuth)/;
interface RouteBinding {
  route: ApplicationRoute;
  instance: object;
  handler: (...args: unknown[]) => unknown;
  metatypes: (new (...args: never[]) => unknown)[];
}
interface ToolBinding {
  instance: object;
  handler: (value: unknown) => unknown;
  schema: ZodTypeAny;
}
class RpcOutput extends PassThrough {
  statusCode = 200;
  headers: Record<string, string | number | string[]> = {};
  headersSent = false;
  constructor(
    private readonly emitHeaders: (status: number, headers: RpcOutput['headers']) => void,
  ) {
    super();
  }
  setHeader(name: string, value: string | number | string[]): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  getHeader(name: string): string | number | string[] | undefined {
    return this.headers[name.toLowerCase()];
  }
  append(name: string, value: string | string[]): this {
    const previous = this.getHeader(name);
    const values = [
      ...(previous === undefined ? [] : Array.isArray(previous) ? previous : [String(previous)]),
      ...(Array.isArray(value) ? value : [value]),
    ];
    return this.setHeader(name, values);
  }
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  flushHeaders(): void {
    if (!this.headersSent) {
      this.headersSent = true;
      this.emitHeaders(this.statusCode, this.headers);
    }
  }
  json(value: unknown): void {
    this.setHeader('content-type', 'application/json');
    this.flushHeaders();
    this.end(JSON.stringify(value));
  }
  override write(
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error: Error | null | undefined) => void),
    callback?: (error: Error | null | undefined) => void,
  ): boolean {
    this.flushHeaders();
    return typeof encodingOrCallback === 'function'
      ? super.write(chunk, encodingOrCallback)
      : encodingOrCallback === undefined
        ? super.write(chunk, callback)
        : super.write(chunk, encodingOrCallback, callback);
  }
}

@Injectable()
export class ControlApplicationRegistry implements OnModuleInit {
  private readonly bindings = new Map<string, RouteBinding>();
  private readonly tools = new Map<string, ToolBinding>();
  private readonly publicTools: ApplicationCatalog['tools'] = [];
  private accepting = true;
  private activeMutations = 0;
  constructor(
    private readonly discovery: DiscoveryService,
    @Inject(PLATFORM_SQLITE) private readonly db: Database.Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly auth: PasscodeGuard,
  ) {}
  onModuleInit(): void {
    if (process.env.PLATFORM_PROCESS_ROLE !== 'coordinator') return;
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS application_operations(id TEXT PRIMARY KEY, actor TEXT NOT NULL,
      digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','complete','unknown')), result TEXT, recorded_at INTEGER NOT NULL)`);
    for (const wrapper of this.discovery.getControllers()) {
      const type = wrapper.metatype,
        instance: unknown = wrapper.instance;
      if (!type || !CONTROLLERS.has(type.name) || !instance || typeof instance !== 'object')
        continue;
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      const prefix: unknown = Reflect.getMetadata(PATH_METADATA, type);
      if (typeof prefix !== 'string') continue;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const candidate = prototype[name];
        if (typeof candidate !== 'function') continue;
        const path: unknown = Reflect.getMetadata(PATH_METADATA, candidate),
          method: unknown = Reflect.getMetadata(METHOD_METADATA, candidate);
        if (typeof path !== 'string' || typeof method !== 'number') continue;
        const verb = RequestMethod[method];
        if (!verb || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(verb)) continue;
        const metadata = (Reflect.getMetadata(ROUTE_ARGS_METADATA, type, name) ?? {}) as Record<
          string,
          { index: number; data?: string; passthrough?: boolean; pipes?: unknown[] }
        >;
        const args = Object.entries(metadata).map(([key, arg]) => ({
          index: arg.index,
          type: Number(key.split(':')[0]),
          name: arg.data,
          passthrough: Reflect.getMetadata('__responsePassthrough__', type, name) === true,
        }));
        const operation = `${type.name}.${name}`;
        const route: ApplicationRoute = {
          operation,
          path:
            '/api/' +
            [prefix, path]
              .map((part) => part.replace(/^\/+|\/+$/g, ''))
              .filter(Boolean)
              .join('/'),
          verb,
          status:
            Reflect.getMetadata(HTTP_CODE_METADATA, candidate) ?? (verb === 'POST' ? 201 : 200),
          args,
        };
        this.bindings.set(operation, {
          route,
          instance,
          handler: candidate as (...args: unknown[]) => unknown,
          metatypes: Reflect.getMetadata(PARAMTYPES_METADATA, prototype, name) ?? [],
        });
      }
    }
    for (const wrapper of this.discovery.getProviders()) {
      const type = wrapper.metatype,
        instance: unknown = wrapper.instance;
      if (!type || !TOOLS.has(type.name) || !instance || typeof instance !== 'object') continue;
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const method of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[method];
        if (typeof handler !== 'function') continue;
        const metadata = Reflect.getMetadata('mcp:tool', handler) as
          { name: string; description: string; parameters: ZodTypeAny } | undefined;
        if (!metadata) continue;
        const operation = `mcp:${type.name}.${method}`;
        this.tools.set(operation, {
          instance,
          handler: handler as (value: unknown) => unknown,
          schema: metadata.parameters,
        });
        this.publicTools.push({
          operation,
          name: metadata.name,
          description: metadata.description,
          inputSchema: zodToOpenAPI(metadata.parameters) as Record<string, unknown>,
        });
      }
    }
  }
  catalog(): ApplicationCatalog {
    return {
      protocol: { min: 1, max: 2 },
      routes: [...this.bindings.values()].map((b) => b.route),
      tools: this.publicTools,
    };
  }
  identity(): object {
    return {
      instanceId: process.env.PLATFORM_INSTANCE_ID,
      role: 'coordinator',
      pid: process.pid,
      artifactDigest: process.env.PLATFORM_COORDINATOR_ACTUAL_DIGEST ?? null,
      inputFingerprint: process.env.PLATFORM_COORDINATOR_ACTUAL_INPUT_FINGERPRINT ?? null,
      startIdentity: process.env.PLATFORM_PROCESS_START_IDENTITY ?? null,
      coordinatorGeneration: Number(process.env.COORDINATOR_GENERATION ?? 0),
      writerFenceValid: process.env.COORDINATOR_WRITER_FENCE_VALID === 'true',
      protocol: { min: 1, max: 2 },
    };
  }
  async quiesce(budgetMs: number): Promise<{ quiesced: true; activeMutations: 0 }> {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 1500)
      throw new BadRequestException('Invalid bounded quiesce budget');
    this.accepting = false;
    const deadline = this.clock.now().getTime() + budgetMs;
    while (this.activeMutations > 0) {
      if (this.clock.now().getTime() >= deadline) {
        this.accepting = true;
        throw new HttpException(
          {
            code: 'APPLICATION_QUIESCE_DEFERRED',
            message: 'Original business is still in flight',
            sideEffectFree: true,
          },
          409,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    return { quiesced: true, activeMutations: 0 };
  }
  resume(): void {
    if (process.env.COORDINATOR_WRITER_FENCE_VALID !== 'true')
      throw new Error('Cannot resume an expired writer');
    this.accepting = true;
  }
  private actor(req: Request): string {
    const cookie = String(req.headers.cookie ?? '');
    const session = cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('ap_session='));
    return createHash('sha256')
      .update(session ?? String(req.headers.authorization ?? 'anonymous'))
      .digest('hex');
  }
  lookup(req: Request, operationId: string): z.infer<typeof ApplicationOperationSchema> {
    if (operationId.length < 1 || operationId.length > 180)
      throw new BadRequestException('Invalid operation identity');
    const row = this.db
      .prepare('SELECT actor,state,result FROM application_operations WHERE id=?')
      .get(operationId) as
      | { actor: string; state: 'pending' | 'complete' | 'unknown'; result: string | null }
      | undefined;
    if (row && row.actor !== this.actor(req)) throw new UnauthorizedException();
    return {
      operationId,
      state: row?.state ?? 'absent',
      resultAvailable: row?.state === 'complete' && row.result !== null,
      ...(row?.state === 'complete' && row.result !== null
        ? { result: JSON.parse(row.result) }
        : {}),
      observedAt: this.clock.now().toISOString(),
    };
  }
  private request(input: ApplicationRequest): Request {
    const request: Request = Object.create(express.request);
    const events = new PassThrough();
    for (const [name, value] of Object.entries({
      headers: input.request.headers,
      method: input.request.method,
      path: input.request.path,
      url: input.request.path,
      originalUrl: input.request.path,
      query: input.request.query,
      protocol: input.request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http',
      socket: { remoteAddress: input.request.remoteAddress },
    }))
      Object.defineProperty(request, name, { value, writable: true, configurable: true });
    request.get = ((name: string) => input.request.headers[name.toLowerCase()]) as Request['get'];
    for (const method of ['on', 'once'] as const)
      Object.defineProperty(request, method, {
        value: (...args: Parameters<PassThrough['on']>) => {
          Reflect.apply(events[method], events, args);
          return request;
        },
      });
    request.emit = events.emit.bind(events);
    return request;
  }
  authenticate(input: ApplicationRequest): { headers: Record<string, string | number | string[]> } {
    const req = this.request(input),
      output = new RpcOutput(() => undefined);
    const res: Response = Object.create(express.response);
    res.setHeader = (name, value) => {
      output.setHeader(name, Array.isArray(value) ? [...value] : (value as string | number));
      return res;
    };
    res.getHeader = output.getHeader.bind(output);
    res.append = (name, value) => {
      if (value !== undefined) output.append(name, value);
      return res;
    };
    const context = new ExecutionContextHost([req, res]);
    context.setType('http');
    this.auth.canActivate(context);
    return { headers: output.headers };
  }
  async invoke(input: ApplicationRequest, response: Response): Promise<void> {
    const binding = this.bindings.get(input.operation),
      tool = this.tools.get(input.operation);
    if (!binding && !tool)
      throw new BadRequestException({
        code: 'APPLICATION_OPERATION_NOT_ALLOWED',
        message: 'Unknown application operation',
      });
    if (!this.accepting)
      throw new HttpException(
        {
          code: 'APPLICATION_WRITER_QUIESCED',
          message: 'Business handoff is pending',
          sideEffectFree: true,
          retryable: true,
        },
        425,
      );
    const req = this.request(input);
    let emitted = false;
    const frame = (value: ApplicationFrame): void => {
      if (!response.headersSent) response.setHeader('content-type', 'application/x-ndjson');
      response.write(JSON.stringify(value) + '\n');
    };
    const output = new RpcOutput((status, headers) => {
      emitted = true;
      frame({ type: 'headers', status, headers });
    });
    const res: Response = Object.create(express.response);
    res.setHeader = (name, value) => {
      output.setHeader(name, Array.isArray(value) ? [...value] : (value as string | number));
      return res;
    };
    res.getHeader = output.getHeader.bind(output);
    res.append = (name, value) => {
      if (value !== undefined) output.append(name, value);
      return res;
    };
    res.status = (code: number) => {
      output.status(code);
      return res;
    };
    res.write = output.write.bind(output);
    Object.defineProperty(res, 'end', {
      value: (...args: Parameters<PassThrough['end']>) => {
        Reflect.apply(output.end, output, args);
        return res;
      },
    });
    res.flushHeaders = output.flushHeaders.bind(output);
    for (const method of ['on', 'once'] as const)
      Object.defineProperty(res, method, {
        value: (...args: Parameters<PassThrough['on']>) => {
          Reflect.apply(output[method], output, args);
          return res;
        },
      });
    res.emit = output.emit.bind(output);
    Object.defineProperty(res, 'headersSent', { get: () => output.headersSent });
    Object.defineProperty(res, 'writableEnded', { get: () => output.writableEnded });
    Object.defineProperty(res, 'statusCode', {
      get: () => output.statusCode,
      set: (value: number) => {
        output.statusCode = value;
      },
    });
    // Authentication is evaluated by the unique authority using the original
    // public cookie/Origin, never the internal RPC socket's loopback identity.
    const context = new ExecutionContextHost([req, res]);
    context.setType('http');
    // The sampler is independently authenticated by the UpgradeController;
    // its Controller key never authorizes an ordinary business operation.
    if (!['UpgradeController.probe', 'UpgradeController.readProbe'].includes(input.operation))
      this.auth.canActivate(context);
    const actor = this.actor(req);
    const mutation = !!tool || (binding?.route.verb !== 'GET' && binding?.route.verb !== 'HEAD');
    const digest = createHash('sha256')
      .update(JSON.stringify({ operation: input.operation, args: input.args }))
      .digest('hex');
    if (mutation) {
      const prior = this.db
        .prepare('SELECT actor,digest,state,result FROM application_operations WHERE id=?')
        .get(input.operationId) as
        { actor: string; digest: string; state: string; result: string | null } | undefined;
      if (prior) {
        if (prior.actor !== actor || prior.digest !== digest)
          throw new BadRequestException({
            code: 'OPERATION_ID_CONFLICT',
            message: 'Operation identity has different input',
          });
        if (prior.state !== 'complete' || prior.result === null)
          throw new HttpException(
            {
              code: 'OPERATION_RESULT_UNKNOWN',
              message: 'Check the original operation result; do not resubmit',
              retryable: false,
            },
            409,
          );
        frame({ type: 'headers', status: binding?.route.status ?? 200, headers: {} });
        frame({ type: 'result', value: JSON.parse(prior.result) });
        frame({ type: 'complete' });
        response.end();
        return;
      }
      this.db
        .prepare("INSERT INTO application_operations VALUES(?,?,?,'pending',NULL,?)")
        .run(input.operationId, actor, digest, this.clock.now().getTime());
    }
    let bytes = false;
    output.on('data', (data: Buffer) => {
      bytes = true;
      frame({ type: 'bytes', data: data.toString('base64') });
    });
    response.once('close', () => {
      req.emit('close');
      output.emit('close');
    });
    if (mutation) this.activeMutations++;
    try {
      const execute = async (): Promise<unknown> => {
        if (tool) return tool.handler.call(tool.instance, tool.schema.parse(input.args[0] ?? {}));
        if (!binding) throw new Error('Missing application binding');
        const args = [...input.args];
        for (const arg of binding.route.args) {
          if (arg.type === RouteParamtypes.REQUEST) args[arg.index] = req;
          else if (arg.type === RouteParamtypes.RESPONSE) args[arg.index] = res;
          else if (
            [RouteParamtypes.BODY, RouteParamtypes.QUERY, RouteParamtypes.PARAM].includes(arg.type)
          )
            args[arg.index] = await platformValidationPipe().transform(args[arg.index], {
              type:
                arg.type === RouteParamtypes.BODY
                  ? 'body'
                  : arg.type === RouteParamtypes.QUERY
                    ? 'query'
                    : 'param',
              metatype: binding.metatypes[arg.index],
              data: arg.name,
            });
        }
        output.statusCode = binding.route.status;
        return binding.handler.apply(binding.instance, args);
      };
      const value = await withRuntimeBusinessAuthority(
        { operationId: input.operationId, actor: { kind: 'user', id: actor } },
        execute,
      );
      if (value instanceof StreamableFile) {
        const headers = value.getHeaders();
        if (headers.type && !output.getHeader('content-type'))
          output.setHeader('content-type', headers.type);
        if (headers.disposition && !output.getHeader('content-disposition'))
          output.setHeader('content-disposition', headers.disposition);
        if (headers.length !== undefined && !output.getHeader('content-length'))
          output.setHeader('content-length', headers.length);
        output.flushHeaders();
        for await (const chunk of value.getStream()) output.write(chunk);
      }
      if (!emitted) output.flushHeaders();
      if (!bytes) frame({ type: 'result', value });
      if (mutation)
        this.db
          .prepare("UPDATE application_operations SET state='complete',result=? WHERE id=?")
          .run(
            SENSITIVE.test(input.operation) || bytes ? null : JSON.stringify(value ?? null),
            input.operationId,
          );
      frame({ type: 'complete' });
      response.end();
    } catch (error) {
      if (mutation)
        this.db
          .prepare(
            "UPDATE application_operations SET state='unknown' WHERE id=? AND state='pending'",
          )
          .run(input.operationId);
      if (emitted) {
        frame({ type: 'error', code: 'APPLICATION_STREAM_UNCONFIRMED' });
        response.end();
        return;
      }
      throw error;
    } finally {
      if (mutation) this.activeMutations--;
    }
  }
}
@Controller('internal/application')
export class ControlRpcController {
  constructor(private readonly registry: ControlApplicationRegistry) {}
  private authorize(req: Request): void {
    const key = process.env.PLATFORM_CONTROL_RPC_KEY,
      supplied = req.headers['x-platform-internal-key'];
    if (
      process.env.PLATFORM_PROCESS_ROLE !== 'coordinator' ||
      !key ||
      key.length < 32 ||
      typeof supplied !== 'string' ||
      req.headers['x-platform-instance-id'] !== process.env.PLATFORM_INSTANCE_ID ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') ||
      Buffer.byteLength(key) !== Buffer.byteLength(supplied) ||
      !timingSafeEqual(Buffer.from(key), Buffer.from(supplied))
    )
      throw new UnauthorizedException();
  }
  @Get('catalog') catalog(@Req() req: Request): ApplicationCatalog {
    this.authorize(req);
    return this.registry.catalog();
  }
  @Get('identity') identity(@Req() req: Request): object {
    this.authorize(req);
    return this.registry.identity();
  }
  @Post('authenticate') authenticate(@Req() req: Request): object {
    this.authorize(req);
    return this.registry.authenticate(ApplicationRequestSchema.parse(req.body));
  }
  @Post('invoke') async invoke(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.authorize(req);
    const input = ApplicationRequestSchema.parse(req.body);
    await this.registry.invoke(input, res);
  }
}
export class ApplicationOperationResponseDto extends createZodDto(ApplicationOperationSchema) {}
@Controller('operations')
export class ApplicationOperationController {
  constructor(private readonly registry: ControlApplicationRegistry) {}
  @Get(':operationId')
  @ApiOkResponse({ type: ApplicationOperationResponseDto })
  lookup(
    @Req() req: Request,
    @Param('operationId') operationId: string,
  ): z.infer<typeof ApplicationOperationSchema> {
    return this.registry.lookup(req, operationId);
  }
}
@Module({
  imports: [DiscoveryModule],
  controllers: [ControlRpcController, ApplicationOperationController],
  providers: [ControlApplicationRegistry, PasscodeGuard],
  exports: [ControlApplicationRegistry],
})
export class ControlRpcModule {}
