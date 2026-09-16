import { describe, it, expect, afterEach } from 'vitest';
import { SystemVersionService } from '../../../src/platform/system/system-version.service';

/**
 * `GET /api/system/version`（10 §6.6）。
 *
 * ⚠️ **这里锁的几乎全是「说不知道」的分支，那正是这个端点的要害。**
 * 版本号是一个用户会照着报障、会拿去比对的值 —— 一个**看起来像真的、但永远是错的**
 * 版本号比没有版本号糟得多。所以「没注入 ⇒ null」「注入了坏值 ⇒ null」这两条
 * 必须有用例钉住；反过来，如果哪天有人给它加一个「兜底读 package.json」的分支，
 * 下面第一条就会红。
 */
const KEYS = ['APP_VERSION', 'APP_COMMIT', 'APP_BUILT_AT'] as const;
const saved = new Map<string, string | undefined>();

function setEnv(patch: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    const v = patch[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

describe('SystemVersionService', () => {
  it('三个都没注入 ⇒ 三个 null（⛔ 不许兜底成 package.json 的包版本）', () => {
    setEnv({});
    expect(new SystemVersionService().snapshot()).toEqual({
      version: null,
      commit: null,
      builtAt: null,
    });
  });

  it('注入了就原样报出来', () => {
    setEnv({
      APP_VERSION: 'v0.1.0',
      APP_COMMIT: '10ee5ff7c0de1a2b3c4d5e6f708192a3b4c5d6e7',
      APP_BUILT_AT: '2026-09-16T08:30:00.000Z',
    });
    expect(new SystemVersionService().snapshot()).toEqual({
      version: 'v0.1.0',
      commit: '10ee5ff7c0de1a2b3c4d5e6f708192a3b4c5d6e7',
      builtAt: '2026-09-16T08:30:00.000Z',
    });
  });

  it('空串与纯空白按「没注入」算 —— docker build 不传 build-arg 时 ENV 落的就是空串', () => {
    setEnv({ APP_VERSION: '', APP_COMMIT: '   ', APP_BUILT_AT: '' });
    expect(new SystemVersionService().snapshot()).toEqual({
      version: null,
      commit: null,
      builtAt: null,
    });
  });

  it('三个字段各自独立缺席 —— 只注了 version 的构建是合法形态，不是坏数据', () => {
    setEnv({ APP_VERSION: 'v0.1.0' });
    expect(new SystemVersionService().snapshot()).toEqual({
      version: 'v0.1.0',
      commit: null,
      builtAt: null,
    });
  });

  // ── builtAt 的形状：这条是契约边界，不是洁癖 ──────────────────────────────
  // `SystemVersionDtoSchema` 声明 `z.string().datetime()`，而值来自构建脚本手里的
  // 一句 shell。原样透传一个形状不对的字符串 = 平台自己吐出违反自己契约的响应。
  it.each([
    ['构建脚本没展开', '$(date -u +%Y-%m-%dT%H:%M:%SZ)'],
    ['随手写的人类时间', '2026年9月16日'],
    ['只有日期没有时刻', 'not-a-date'],
  ])('builtAt 解析不了 ⇒ null（%s）', (_label, raw) => {
    setEnv({ APP_BUILT_AT: raw });
    expect(new SystemVersionService().snapshot().builtAt).toBeNull();
  });

  it('能解析但写法不合 datetime() 的，归一化成合规 ISO 而不是原样透传', () => {
    // `Date.parse` 收这个空格写法，`z.string().datetime()` 不收 —— 原样放过去照样违约。
    setEnv({ APP_BUILT_AT: '2026-09-16 08:30:00Z' });
    const { builtAt } = new SystemVersionService().snapshot();
    expect(builtAt).toBe('2026-09-16T08:30:00.000Z');
  });
});
