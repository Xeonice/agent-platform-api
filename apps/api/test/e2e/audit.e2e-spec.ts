import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { extract as tarExtract } from 'tar';
import {
  AUDIT_RECORDER,
  SANDBOX_PROVIDER_REGISTRY,
  WORKSPACE_PREPARER,
  PROJECT_FACADE,
  IMAGE_SPEC_REGISTRY,
} from '@platform/contracts';
import type { AuditRecorder } from '@platform/contracts';
import { AppModule } from '../../src/app.module';
import { configurePlatformApp } from '../../src/bootstrap/configure-app';
import { AuditRepository } from '../../src/platform/audit/audit.repository';
import {
  makeFakeImageSpecRegistry,
  registerDefaultImage,
  fakeProjectFacade,
  fakeWorkspace,
  makeFakeRegistry,
} from './_fakes';

/**
 * `GET /api/system/audit` + `/audit/export` 的接口 e2e（25 §6.1）。
 *
 * 走的是**生产装配**（`configurePlatformApp`）——错误信封断言因此测的是线上真会出现
 * 的那个形状（见那个函数的长注释：19/20 个 e2e 曾经手抄装配、漏掉 filter，
 * 于是每条错误断言都在测一个生产上不存在的形状）。
 */
let app: INestApplication;
let audit: AuditRecorder;

beforeAll(async () => {
  process.env.DATABASE_URL = ':memory:';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SANDBOX_PROVIDER_REGISTRY)
    .useValue(makeFakeRegistry())
    .overrideProvider(WORKSPACE_PREPARER)
    .useValue(fakeWorkspace)
    .overrideProvider(PROJECT_FACADE)
    .useValue(fakeProjectFacade)
    .overrideProvider(IMAGE_SPEC_REGISTRY)
    .useValue(makeFakeImageSpecRegistry())
    .compile();
  app = moduleRef.createNestApplication();
  configurePlatformApp(app);
  await app.init();
  await app.listen(0);
  await registerDefaultImage(app);

  audit = app.get<AuditRecorder>(AUDIT_RECORDER);
  // 12 条已知内容的记录，用来钉住游标与筛选（seq 从 1 起，因为库是 :memory: 新开的）。
  for (let i = 0; i < 12; i++) {
    audit.record({
      category: i % 2 === 0 ? 'sandbox' : 'project',
      type: 'test.seed',
      // 10 = 唯一一条 warn，11 = 唯一一条 error —— 「仅告警」那组断言要的就是这两条。
      severity: i === 10 ? 'warn' : i === 11 ? 'error' : 'info',
      subjectType: 'sandbox',
      subjectId: `sbx-${String(i % 3)}`,
      actor: 'system',
      summary: `seed ${String(i)}`,
    });
  }
});

afterAll(async () => {
  await app?.close();
});

/** 本套件自己写的那 12 条的 seq 区间 —— 前面可能已有 provision 产生的记录。 */
function seededSeqs(): number[] {
  const repo = app.get(AuditRepository);
  return repo
    .list({ limit: 500 })
    .items.filter((i) => i.type === 'test.seed')
    .map((i) => i.seq)
    .sort((a, b) => a - b);
}

describe('GET /api/system/audit —— 双向游标（10 §6.6.1）', () => {
  it('不带游标：从最新开始，恒按 seq 降序', async () => {
    const res = await request(app.getHttpServer()).get('/api/system/audit').expect(200);
    const seqs: number[] = res.body.items.map((i: { seq: number }) => i.seq);
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    expect(typeof res.body.hasMore).toBe('boolean');
  });

  it('since 向新、before 向老 —— 两个方向不能反', async () => {
    const all = seededSeqs();
    const pivot = all[5]!;
    const newer = await request(app.getHttpServer())
      .get(`/api/system/audit?since=${String(pivot)}`)
      .expect(200);
    expect(newer.body.items.every((i: { seq: number }) => i.seq > pivot)).toBe(true);

    const older = await request(app.getHttpServer())
      .get(`/api/system/audit?before=${String(pivot)}`)
      .expect(200);
    expect(older.body.items.every((i: { seq: number }) => i.seq < pivot)).toBe(true);
  });

  /**
   * ⚠️ **`since` 拉满 limit 意味着有断层，必须显性传达。** 异常风暴时 30s 内 >200 条
   * 事件 —— 那恰恰是最需要看清的时刻 —— 一次拉不完；前端若只 prepend 一页就停，
   * 列表中间会出现看不见的空洞（10 §6.6.1）。
   */
  it('hasMore 在拉满时为 true、取尽时为 false', async () => {
    const first = seededSeqs()[0]!;
    const cut = first - 1;
    const partial = await request(app.getHttpServer())
      .get(`/api/system/audit?since=${String(cut)}&limit=3`)
      .expect(200);
    expect(partial.body.items).toHaveLength(3);
    expect(partial.body.hasMore).toBe(true);

    const full = await request(app.getHttpServer())
      .get(`/api/system/audit?since=${String(cut)}&limit=500`)
      .expect(200);
    expect(full.body.hasMore).toBe(false);
  });

  it('since 与 before 互斥：同传 400 VALIDATION_FAILED（真信封，不是裸 Nest 异常）', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/system/audit?since=1&before=5')
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.retryable).toBe(false);
    // 纯读请求的参数冲突 —— 连库都没碰，所以这个标记由构造成立（04 §4.1）。
    expect(res.body.sideEffectFree).toBe(true);
  });

  it('limit 上限 500，超了是 400 而不是悄悄夹紧', async () => {
    await request(app.getHttpServer()).get('/api/system/audit?limit=501').expect(400);
    await request(app.getHttpServer()).get('/api/system/audit?limit=500').expect(200);
  });

  it('category / severity / subjectId 筛选生效，且与游标正交', async () => {
    const bySeverity = await request(app.getHttpServer())
      .get('/api/system/audit?severity=error&limit=500')
      .expect(200);
    expect(bySeverity.body.items.every((i: { severity: string }) => i.severity === 'error')).toBe(
      true,
    );

    const first = seededSeqs()[0]!;
    const combo = await request(app.getHttpServer())
      .get(`/api/system/audit?since=${String(first - 1)}&category=project&limit=500`)
      .expect(200);
    expect(combo.body.items.every((i: { category: string }) => i.category === 'project')).toBe(
      true,
    );
    expect(combo.body.items.every((i: { seq: number }) => i.seq > first - 1)).toBe(true);
  });

  it('from/to 是时间过滤，不是翻页 —— to 在未来时不影响结果集大小', async () => {
    const wide = await request(app.getHttpServer())
      .get('/api/system/audit?from=2000-01-01T00:00:00.000Z&limit=500')
      .expect(200);
    const plain = await request(app.getHttpServer()).get('/api/system/audit?limit=500').expect(200);
    expect(wide.body.items).toHaveLength(plain.body.items.length);

    const none = await request(app.getHttpServer())
      .get('/api/system/audit?to=2000-01-01T00:00:00.000Z&limit=500')
      .expect(200);
    expect(none.body.items).toHaveLength(0);
  });
});

/**
 * `?severity=` 的**多值**（10 §6.6.1）—— 产品要的「仅告警」= `warn ∪ error`。
 *
 * ⚠️ 它此前是等值过滤（`eq`），于是「仅告警」在契约层面**无法表达**：前端只能拉回
 * 一页再在客户端裁，而裁的是「最近 200 条」。平台平稳跑一周、最近 200 条全是 info
 * 时，用户勾「仅告警」看到的是「当前筛选无匹配记录」——结论变成「平台从没告警过」，
 * 而那次 provision 失败就在第 201 条。服务端 `IN (...)` 之后 `LIMIT` 取的是**匹配行**
 * 的最新一页，「空 + hasMore:false」才真的等于「全表没有告警」。
 * 「告警在更老的位置也拿得到」那条在 `test/integration/audit-repository.spec.ts` 里
 * （要 200+ 条种子，走 repo 更直接）；这里钉的是**线格式**：逗号、去重、非法值。
 */
describe('GET /api/system/audit —— severity 多值（「仅告警」）', () => {
  const severitiesOf = (body: { items: { severity: string }[] }): string[] =>
    body.items.map((i) => i.severity);

  it('severity=warn,error 同时回 warn 与 error，一条 info 都不带', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/system/audit?severity=warn,error&limit=500')
      .expect(200);
    const got = severitiesOf(res.body);
    expect(got.length).toBeGreaterThan(0);
    expect(got).toContain('warn');
    expect(got).toContain('error');
    // ⚠️ 这一行是「只回了其中一个值」那种变异的钉子（比如只取多值里的第一个）。
    expect(got.every((s) => s === 'warn' || s === 'error')).toBe(true);
  });

  it('单值 severity=error 照旧工作（向后兼容，此前的调用方不用改）', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/system/audit?severity=error&limit=500')
      .expect(200);
    const got = severitiesOf(res.body);
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((s) => s === 'error')).toBe(true);
  });

  it('重复值去重，结果与不重复时逐条相同', async () => {
    const dup = await request(app.getHttpServer())
      .get('/api/system/audit?severity=warn,warn,error,warn&limit=500')
      .expect(200);
    const plain = await request(app.getHttpServer())
      .get('/api/system/audit?severity=warn,error&limit=500')
      .expect(200);
    expect(dup.body.items.map((i: { seq: number }) => i.seq)).toEqual(
      plain.body.items.map((i: { seq: number }) => i.seq),
    );
  });

  it('含非法值 ⇒ 400 VALIDATION_FAILED（真信封，带 sideEffectFree）', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/system/audit?severity=warn,critical')
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.retryable).toBe(false);
    // 纯读请求的参数问题，pipe 跑在 controller 之前 —— 与 since/before 互斥那条同一套。
    expect(res.body.sideEffectFree).toBe(true);
    // ⚠️ 信封里**不许回显用户提交的原始值**（validation-envelope.ts 的纪律）。
    expect(JSON.stringify(res.body)).not.toContain('critical');
  });
});

describe('GET /api/system/audit/export —— tar.gz（P21-5 §10.3）', () => {
  it('回一个真的 gzip tar，含 audit.jsonl / diagnose.json / export-range.json', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/system/audit/export')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(res.headers['content-type']).toBe('application/gzip');
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="audit-export-.*\.tar\.gz"/,
    );
    // gzip 魔数 —— 「回了 200 但内容是一段 JSON 错误」是这条断言挡的东西。
    const body: Buffer = res.body;
    expect(body[0]).toBe(0x1f);
    expect(body[1]).toBe(0x8b);

    const dir = mkdtempSync(join(tmpdir(), 'audit-export-test-'));
    try {
      const archive = join(dir, 'export.tar.gz');
      writeFileSync(archive, body);
      await tarExtract({ file: archive, cwd: dir });

      const jsonl = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n');
      expect(jsonl.length).toBeGreaterThan(0);
      // 每行是一条完整 DTO，按 seq **升序**（一条流水该按时间正序读）。
      const seqs = jsonl.map((l) => (JSON.parse(l) as { seq: number }).seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

      const range = JSON.parse(readFileSync(join(dir, 'export-range.json'), 'utf8'));
      expect(range.maxBytes).toBe(50 * 1024 * 1024);
      expect(range.requestedWindow.hours).toBe(24);
      expect(range.audit.events).toBe(jsonl.length);
      // ⚠️ **runtime.log 缺席时必须写清缺失原因**，不是静默省略：
      // 「截断了却不说，会让人以为日志本来就只有这些」（P21-5 §10.3）。
      if (range.runtimeLog.included === false) {
        expect(String(range.runtimeLog.omittedReason).length).toBeGreaterThan(10);
      }

      const diagnose = JSON.parse(readFileSync(join(dir, 'diagnose.json'), 'utf8'));
      expect(diagnose.resources.cpuCount).toBeGreaterThan(0);
      // 诊断端点还没落地 ⇒ 这里**不假装跑过一轮检查**。
      expect(diagnose.checks).toEqual([]);
      expect(typeof diagnose.checksUnavailable).toBe('string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('审计流真的被业务链路写满（写入口 ① + ②）', () => {
  it('一次创建沙箱之后，既有 projector 的状态流转，也有 workflow 的阶段耗时', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId: 'prj-audit', runtime: 'claude-code' })
      .expect(201);
    const id = created.body.id as string;

    const deadline = Date.now() + 5000;
    let types: string[] = [];
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/api/system/audit?subjectId=${id}&limit=500`)
        .expect(200);
      types = res.body.items.map((i: { type: string }) => i.type);
      if (types.includes('sandbox.provision.stage') && types.includes('sandbox.state_changed')) {
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    // 入口 ①（projector，post-commit microtask）
    expect(types).toContain('sandbox.created');
    expect(types).toContain('sandbox.state_changed');
    // 入口 ②（应用层显式；03 §7.8 的三个 type）
    expect(types).toContain('sandbox.provision.stage');
    expect(types).toContain('sandbox.workspace.prepared');
    expect(types).toContain('sandbox.agent_session');

    const stages = await request(app.getHttpServer())
      .get(`/api/system/audit?subjectId=${id}&limit=500`)
      .expect(200);
    const provision = stages.body.items.filter(
      (i: { type: string }) => i.type === 'sandbox.provision.stage',
    );
    // 「哪一步慢了」—— 每条阶段记录都必须带 durationMs 与 outcome，否则这张表白建。
    for (const s of provision) {
      expect(typeof s.durationMs).toBe('number');
      expect(['ok', 'failed']).toContain(s.outcome);
      expect(typeof s.detail.stage).toBe('string');
    }
    expect(provision.map((s: { detail: { stage: string } }) => s.detail.stage)).toEqual(
      expect.arrayContaining(['preparing-workspace', 'creating', 'starting', 'provision']),
    );
  });
});
