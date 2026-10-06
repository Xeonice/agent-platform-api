import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AutomationAttentionItemSchema } from '@platform/contracts';
import { UNIT_OF_WORK, asAutomationId } from '@platform/shared-kernel';
import type { UnitOfWork } from '@platform/shared-kernel';
import { AUTOMATION_REPOSITORY } from '../../../packages/modules/automation/src/domain/repositories/automation.repository';
import type { AutomationRepository } from '../../../packages/modules/automation/src/domain/repositories/automation.repository';
import { AppModule } from '../../../apps/api/src/app.module';
import { configurePlatformApp } from '../../../apps/api/src/bootstrap/configure-app';
import { useEnv } from '../../support/strict-ports';

let app: INestApplication;
let dataRoot: string;
let restoreEnv: () => void;

beforeAll(async () => {
  dataRoot = mkdtempSync(resolve(process.cwd(), 'tmp-attention-e2e-'));
  restoreEnv = useEnv({
    DATABASE_URL: ':memory:',
    DATA_ROOT: dataRoot,
    DISABLE_AUTOMATION_SCHEDULER: '1',
    DISABLE_VOLUME_REAPER: '1',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configurePlatformApp(app);
  await app.init();
  await app.listen(0);
}, 60_000);

afterAll(async () => {
  await app?.close();
  restoreEnv?.();
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
});

const http = () => request(app.getHttpServer());
const ruleInput = {
  runtime: 'codex',
  prompt: 'run regression checks',
  scheduleKind: 'daily',
  scheduleConfig: { time: '03:00' },
  timezone: 'Asia/Shanghai',
  timeoutMinutes: 120,
  artifactRetentionDays: 7,
};

describe('cross-project automation attention (AC-AUT-004.6)', () => {
  it('returns only affected rules with project names in one read, preserving all rule state', async () => {
    const projectIds: string[] = [];
    for (const name of ['示例项目', 'acme-web', 'docs-site']) {
      const response = await http()
        .post('/api/projects')
        .send({ name, sourceType: 'empty' })
        .expect(202);
      projectIds.push(response.body.id as string);
    }
    const disabled = await http()
      .post(`/api/projects/${projectIds[0]}/automations`)
      .send({ ...ruleInput, name: '每日报表' })
      .expect(201);
    const degraded = await http()
      .post(`/api/projects/${projectIds[1]}/automations`)
      .send({ ...ruleInput, name: '构建告警' })
      .expect(201);
    const manual = await http()
      .post(`/api/projects/${projectIds[1]}/automations`)
      .send({ ...ruleInput, name: '用户关掉的规则' })
      .expect(201);
    const normal = await http()
      .post(`/api/projects/${projectIds[1]}/automations`)
      .send({ ...ruleInput, name: '正常规则' })
      .expect(201);
    const repo = app.get<AutomationRepository>(AUTOMATION_REPOSITORY);
    const uow = app.get<UnitOfWork>(UNIT_OF_WORK);
    for (const [id, failures] of [
      [disabled.body.id as string, 10],
      [degraded.body.id as string, 3],
    ] as const) {
      const rule = await repo.findById(asAutomationId(id));
      if (rule === null) throw new Error('seeded automation missing');
      for (let index = 0; index < failures; index += 1) rule.recordOutcome('failed', new Date());
      uow.run((tx) => repo.saveSync(tx, rule));
    }
    await http().post(`/api/automations/${manual.body.id}/disable`).expect(200);
    const ids = [disabled.body.id, degraded.body.id, manual.body.id, normal.body.id] as string[];
    const before = await Promise.all(
      ids.map((id) => http().get(`/api/automations/${id}`).expect(200)),
    );

    const response = await http().get('/api/automations/attention').expect(200);
    const items = AutomationAttentionItemSchema.array().parse(response.body);
    expect(items).toEqual([
      {
        projectId: projectIds[0],
        projectName: '示例项目',
        id: disabled.body.id,
        name: '每日报表',
        status: 'autoDisabled',
        consecutiveFailures: 10,
      },
      {
        projectId: projectIds[1],
        projectName: 'acme-web',
        id: degraded.body.id,
        name: '构建告警',
        status: 'degraded',
        consecutiveFailures: 3,
      },
    ]);
    const after = await Promise.all(
      ids.map((id) => http().get(`/api/automations/${id}`).expect(200)),
    );
    expect(after.map((result) => result.body)).toEqual(before.map((result) => result.body));
  });
});
