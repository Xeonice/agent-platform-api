import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { RetainedVolumeService, VolumeReaper } from '@platform/project';
import { AppModule } from '../../src/app.module';
import { configurePlatformApp } from '../../src/bootstrap/configure-app';
import { AuditRepository } from '../../src/platform/audit/audit.repository';
import { useEnv } from './_env';

/**
 * 「已保留卷」整条切片的 REST e2e（10 §6.2 / 27 §2 / 03 §7.7）。
 *
 * ── 这个文件证明的是什么 ────────────────────────────────────────────────────────
 * 单测证明了算术与编排；这里证明的是**下载真的能走完**：`Content-Length` 与真正发出去
 * 的字节数相等，包能被系统 `tar` 解开，解出来的东西按 git 口径挑过（`node_modules`
 * 不在包里、`.git` 在包里）。带错长度的流会被截断或吊死，而那种错误只有真跑一次 HTTP
 * 才看得见 —— 单测里两边读的是同一份计划。
 *
 * ── 每条断言钉住的变异 ──────────────────────────────────────────────────────────
 *  ① 控制器不传 `length` ⇒「content-length 存在且等于 body 长度」红（浏览器进度条没了）。
 *  ② 把 tar 换成 gzip / 改动 `planTarArchive` 的算术 ⇒ 同一条红（长度对不上）。
 *  ③ `listWorkspaceArchiveEntries` 去掉 `--exclude-standard` ⇒ `node_modules` 出现在
 *     包里，「排除生效」红。
 *  ④ `DELETE` 之后不置 `deletedAt`（或列表不过滤已清理）⇒「删完就不在列表里」红。
 */
let app: INestApplication;
let dataRoot: string;
let restoreEnv: () => void;
let workspacePath: string;
let projectId: string;

/** 造一个「像真的一样」的工作区：git 仓 + .gitignore 命中的大目录 + 未跟踪的成果。 */
function seedWorkspace(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@e',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@e',
      },
    });
  git('init', '-q', '-b', 'main');
  writeFileSync(resolve(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(resolve(dir, 'src.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  writeFileSync(resolve(dir, 'AGENT-RESULT.md'), '# what the agent produced\n');
  mkdirSync(resolve(dir, 'node_modules/left-pad'), { recursive: true });
  writeFileSync(resolve(dir, 'node_modules/left-pad/index.js'), 'x'.repeat(200_000));
}

beforeAll(async () => {
  dataRoot = mkdtempSync(resolve(process.cwd(), 'tmp-retained-e2e-'));
  // ⚠️ 走 `useEnv` 而不是裸赋值/裸 delete：e2e 是 singleFork（BoxLite 一个 home 只允许
  // 一个 runtime），`process.env` 全进程共享，裸 delete 会把开发者 shell 里的值**抹掉**
  // 而不是还原 —— 由 `suite-hygiene.e2e-spec.ts` 机械把关。
  restoreEnv = useEnv({
    DATABASE_URL: ':memory:',
    DISABLE_VOLUME_REAPER: '1', // 定时器不该在 e2e 里自己跑
    DATA_ROOT: dataRoot,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configurePlatformApp(app);
  await app.init();
  await app.listen(0);

  const created = await request(app.getHttpServer())
    .post('/api/projects')
    .send({ name: `rv-e2e-${String(Date.now())}`, sourceType: 'empty' })
    .expect(202);
  projectId = created.body.id as string;

  workspacePath = resolve(dataRoot, 'workspaces', 'sbx-retained-e2e');
  seedWorkspace(workspacePath);
  // 登记走的是真正的那条命令（24 §3），不是往库里手插一行
  await app.get(RetainedVolumeService).register({
    projectId,
    sandboxId: 'sbx-retained-e2e',
    workspacePath,
    source: 'manual-destroy',
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  restoreEnv?.();
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
});

describe('GET/DELETE /api/retained-volumes（+ /archive）', () => {
  it('列表按项目查，两个大小都给，且**不含** workspacePath', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/retained-volumes?projectId=${projectId}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    const [dto] = res.body;
    expect(dto.projectId).toBe(projectId);
    expect(dto.sandboxId).toBe('sbx-retained-e2e');
    expect(dto.source).toBe('manual-destroy');
    // ★ 差一个数量级的两个数：磁盘含 node_modules，下载包不含
    expect(dto.diskBytes).toBeGreaterThan(dto.downloadBytes);
    expect(new Date(dto.retainUntil).getTime()).toBeGreaterThan(new Date(dto.retainedAt).getTime());
    // ⛔ 宿主绝对路径不出现在任何一个字段里
    expect(JSON.stringify(dto)).not.toContain(dataRoot);
  });

  it('未知项目 ⇒ 空数组（不是 404）', async () => {
    await request(app.getHttpServer())
      .get('/api/retained-volumes?projectId=prj-does-not-exist')
      .expect(200)
      .expect([]);
  });

  it('★ /archive：content-length 与真正发出去的字节数相等，且包能被系统 tar 解开', async () => {
    const [dto] = (await request(app.getHttpServer()).get('/api/retained-volumes').expect(200))
      .body;
    const res = await request(app.getHttpServer())
      .get(`/api/retained-volumes/${dto.id}/archive`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(res.headers['content-type']).toContain('application/x-tar');
    expect(res.headers['content-disposition']).toContain('sbx-retained-e2e.tar');
    // ★ 这一条就是「不压缩」换来的东西：浏览器原生进度条的全部前提
    const declared = Number(res.headers['content-length']);
    expect(Number.isFinite(declared)).toBe(true);
    expect((res.body as Buffer).length).toBe(declared);
    expect(declared).toBe(dto.downloadBytes);

    const out = mkdtempSync(resolve(dataRoot, 'unpack-'));
    const tarball = resolve(out, 'volume.tar');
    writeFileSync(tarball, res.body as Buffer);
    execFileSync('tar', ['-xf', tarball, '-C', out]);
    // git 口径：已跟踪 + 未跟踪未 ignore 都在，`.git` 在，`.gitignore` 命中的不在
    expect(existsSync(resolve(out, 'src.ts'))).toBe(true);
    expect(existsSync(resolve(out, 'AGENT-RESULT.md'))).toBe(true);
    expect(existsSync(resolve(out, '.git/HEAD'))).toBe(true);
    expect(existsSync(resolve(out, 'node_modules'))).toBe(false);
  });

  it('★ DELETE 删目录、置 deletedAt，之后列表里没有它、下载也 404（I-RV-2）', async () => {
    const [dto] = (await request(app.getHttpServer()).get('/api/retained-volumes').expect(200))
      .body;
    await request(app.getHttpServer()).delete(`/api/retained-volumes/${dto.id}`).expect(204);

    expect(existsSync(workspacePath)).toBe(false);
    await request(app.getHttpServer()).get('/api/retained-volumes').expect(200).expect([]);
    // 已清理的记录对外等于不存在
    await request(app.getHttpServer()).delete(`/api/retained-volumes/${dto.id}`).expect(404);
    await request(app.getHttpServer()).get(`/api/retained-volumes/${dto.id}/archive`).expect(404);
  });

  it('审计流里留下了保留与清理两行（13 §2.8.2 的 project 档）', async () => {
    const rows = app.get(AuditRepository).list({ limit: 100 });
    const types = rows.items.map((r) => r.type);
    expect(types).toContain('project.volume_retained');
    expect(types).toContain('project.volume_deleted');
  });

  it('VolumeReaper 一轮扫过：没到期的一条都不动', async () => {
    // 上一条用例已经把唯一那条清掉了；这里证明 reaper 不会去碰只读记录
    // （少了 `deleted_at IS NULL` 这一条会红：它会去 rm 一个不存在的目录再撞 I-RV-2）
    expect(await app.get(VolumeReaper).runOnce()).toBe(0);
  });
});
