/* Emit openapi.json without starting the HTTP server (09 §2.3 drift gate). */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { patchNestJsSwagger } from 'nestjs-zod';
import { AppModule } from '../app.module';

async function main(): Promise<void> {
  process.env.DATABASE_URL = ':memory:';
  patchNestJsSwagger();
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  const config = new DocumentBuilder().setTitle('Agent Platform API').setVersion('0.0.1').build();
  const document = SwaggerModule.createDocument(app, config);
  const out = resolve(process.cwd(), 'openapi.json');
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
  await app.close();
  console.log(`wrote ${out}`);
}

void main();
