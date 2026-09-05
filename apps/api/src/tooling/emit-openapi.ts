/* Emit openapi.json without starting the HTTP server (09 §2.3 drift gate). */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { patchNestJsSwagger } from 'nestjs-zod';
import { AppModule } from '../app.module';
import { ErrorEnvelope } from '../bootstrap/error-envelope.dto';

async function main(): Promise<void> {
  process.env.DATABASE_URL = ':memory:';
  patchNestJsSwagger();
  // ⚠️ **`abortOnError: false` + 一个真的 catch**（2026-09-05 补）。此前是
  //    `NestFactory.create(AppModule, { logger: false })`：装配一旦失败，Nest 默认
  //    `abortOnError: true` 会**用它自己的 logger 打印再 abort**，而 logger 关着 ⇒
  //    整个脚本**静默 exit 1，一个字都不说**。实测撞上时只能靠改脚本才知道错在哪 ——
  //    一个不说话的门禁比没有门禁更贵。
  const app = await NestFactory.create(AppModule, { logger: ['error'], abortOnError: false });
  app.setGlobalPrefix('api');
  const config = new DocumentBuilder().setTitle('Agent Platform API').setVersion('0.0.1').build();
  const document = SwaggerModule.createDocument(app, config, {
    extraModels: [ErrorEnvelope],
  });
  const out = resolve(process.cwd(), 'openapi.json');
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
  await app.close();
  console.log(`wrote ${out}`);
}

void main().catch((e: unknown) => {
  // ⚠️ `void main()` 单独用会把 rejection 变成 unhandled，配合上面那个 abort 就是静默。
  console.error(`emit-openapi 失败：${(e as Error).message}`);
  console.error((e as Error).stack ?? '');
  process.exitCode = 1;
});
