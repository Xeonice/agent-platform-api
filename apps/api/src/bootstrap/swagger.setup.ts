import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { patchNestJsSwagger } from 'nestjs-zod';

/**
 * OpenAPI mount (docs/backend/02 §8).
 *   - patchNestJsSwagger() teaches @nestjs/swagger to reflect zod
 *     enums/discriminatedUnions faithfully into openapi.json (P1-4).
 *   - jsonDocumentUrl:'openapi.json' → the spec is served at /openapi.json,
 *     the single codegen source for the frontend (10). NestJS default is
 *     `${path}-json`, so this is set explicitly.
 */
export function setupSwagger(app: INestApplication): void {
  patchNestJsSwagger();
  const config = new DocumentBuilder()
    .setTitle('Agent Platform API')
    .setDescription('云 agent 管理平台后端 — REST + MCP dual protocol')
    .setVersion('0.0.1')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'openapi.json' });
}
