import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Mechanical guards on shared-process hygiene in the e2e suite.
 *
 * WHY THIS EXISTS: the `e2e` project runs `poolOptions.forks.singleFork` — BoxLite
 * allows one runtime per home, so EVERY e2e spec shares ONE process, and therefore
 * one `process.env`. A spec that tears down with a bare `delete process.env.X` does
 * not restore the environment, it ERASES it for every spec that runs afterwards.
 *
 * The bug that produces is the expensive kind: it depends on FILE ORDER, and vitest
 * varies file order with its duration cache — so the same tree is green on one
 * machine and red on another, nobody can reproduce it, and the team learns to just
 * re-run CI. A test suite people re-run on red is worse than one that fails honestly.
 *
 * So the rule is enforced here rather than trusted: `_env.ts#useEnv` is the ONE place
 * allowed to unset a variable, because it captures the prior value first and can tell
 * "was unset" from "was set to something else" — which a bare `delete` cannot.
 */
const E2E_DIR = dirname(fileURLToPath(import.meta.url));
/**
 * Files exempt from the scan: `_env.ts` is the one sanctioned place that may unset a
 * variable (it captures the prior value first), and this guard itself quotes the
 * forbidden pattern inside its own failure message.
 */
const EXEMPT = new Set(['_env.ts', 'suite-hygiene.e2e-spec.ts']);

function e2eSources(): Array<{ file: string; text: string }> {
  return readdirSync(E2E_DIR)
    .filter((f) => f.endsWith('.ts') && !EXEMPT.has(f))
    .map((file) => ({ file, text: readFileSync(resolve(E2E_DIR, file), 'utf8') }));
}

describe('e2e process.env hygiene (singleFork ⇒ one shared environment)', () => {
  it('no spec unsets an env var directly — `useEnv` from _env.ts saves and restores', () => {
    const offenders = e2eSources()
      .filter(({ text }) => /delete\s+process\.env\b/.test(stripComments(text)))
      .map(({ file }) => file);

    expect(
      offenders,
      `${offenders.join(', ')} unset an environment variable directly. Every e2e spec ` +
        'shares ONE process (singleFork), so a bare `delete process.env.X` leaks into ' +
        'every later spec and makes failures depend on file order. Use ' +
        '`useEnv({ X: undefined })` from ./_env — it restores the prior value, ' +
        'including "was not set at all".',
    ).toEqual([]);
  });

  it('every spec that configures ACCESS_PASSCODE does it through useEnv', () => {
    // ACCESS_PASSCODE flips a GLOBAL security behaviour (the guard self-disables when
    // it is empty) and `PasscodeService.enabled` snapshots it at construction — so a
    // leaked value does not fail loudly, it silently turns authentication OFF and the
    // spec fails much later with something like `expected 200 to be 401`.
    const offenders = e2eSources()
      .filter(({ text }) => /process\.env\.ACCESS_PASSCODE\s*=/.test(stripComments(text)))
      .map(({ file }) => file);

    expect(
      offenders,
      `${offenders.join(', ')} assign process.env.ACCESS_PASSCODE directly; route it ` +
        'through `useEnv` from ./_env so the value is restored for later specs.',
    ).toEqual([]);
  });

  it('every spec that configures SANDBOX_DEFAULT_IMAGE does it through useEnv', () => {
    // ⚠️ 这一条是 2026-08-29 真踩出来的,而它踩出来的方式本身值得记:
    // `SANDBOX_DEFAULT_IMAGE` 决定 `ImageSeeder` 在**后面每一个文件**的 `app.init()` 里
    // 去播种哪张镜像。三个 docker-gated 的文件裸赋值它、从不还原,于是泄漏之后
    // `registry-extension.e2e` 的 `registerImage(SANDBOX_DEFAULT_IMAGE ?? 'alpine:3.20')`
    // 撞上「播种时已经注册过了」而 `created:false`。
    //
    // ⛔ **而 CI 从来没红过,因为 CI 上没有 AIO 镜像 ⇒ 那三个文件全被跳过 ⇒ 泄漏根本
    // 不发生。** 也就是说:这是一条**只在测试真的跑起来时才存在**的串扰 —— 跳过不是通过,
    // 它连「有没有这个 bug」都答不了。
    const offenders = e2eSources()
      .filter(({ text }) => /process\.env\.SANDBOX_DEFAULT_IMAGE\s*=[^=]/.test(stripComments(text)))
      .map(({ file }) => file);

    expect(
      offenders,
      `${offenders.join(', ')} assign process.env.SANDBOX_DEFAULT_IMAGE directly; route ` +
        'it through `useEnv` from ./_env. It decides what `ImageSeeder` seeds in every ' +
        'LATER spec, so a leaked value silently changes their catalogue.',
    ).toEqual([]);
  });
});

describe('e2e HTTP hygiene (an ephemeral port must not be shared by accident)', () => {
  it('every spec driving supertest listens once, instead of rebinding per request', () => {
    // supertest binds `server.listen(0)` per request when the server is NOT already
    // listening, and CLOSES it right after. In a single-process suite full of other
    // listeners (other Nest apps, socket.io, the local git server, forwarded sandbox
    // agent ports) that freed port can be reassigned to somebody else between
    // supertest reading `address().port` and the request being written — so the
    // request is answered by a FOREIGN server.
    //
    // The symptom is a status that the route under test cannot possibly return, e.g.
    // a passcode-protected `POST /api/access/unlock` answering 200 (that is another
    // app whose guard is disabled), or `POST /api/projects` — hard-coded
    // `@HttpCode(202)` — answering 200. Both were observed; both disappear when the
    // server holds ONE port for the whole file.
    const offenders = e2eSources()
      .filter(({ text }) => {
        const code = stripComments(text);
        return /request\((?:\w+)\.getHttpServer\(\)\)/.test(code) && !/\.listen\(/.test(code);
      })
      .map(({ file }) => file);

    expect(
      offenders,
      `${offenders.join(', ')} drive HTTP through supertest without ever calling ` +
        '`await app.listen(0)`. Add it right after `app.init()` so the server keeps ONE ' +
        'port for the whole file; otherwise supertest rebinds an ephemeral port per ' +
        'request and a race can send the request to a different server in this shared ' +
        'process.',
    ).toEqual([]);
  });
});

describe('e2e validation hygiene (tests must boot the pipe production boots)', () => {
  it('no spec constructs `nestjs-zod`’s bare ZodValidationPipe', () => {
    // WHY THIS IS MECHANICAL RATHER THAN TRUSTED: this pipe used to be `new`-ed 17
    // times — `main.ts` once, and 16 more times by e2e files each booting their own
    // app. When the platform swapped it for one that emits a real `ErrorEnvelope`
    // (04 §4: `code` / `message` / `retryable` / `sideEffectFree`), changing only
    // `main.ts` would have left PRODUCTION on the envelope pipe and every e2e on the
    // bare one — i.e. the suite would keep passing against a pipe nobody ships, and
    // no test could ever notice the envelope regressing.
    //
    // That is not a thing to remember; it is a thing to make impossible. Every app —
    // production and test — goes through `platformValidationPipe()`.
    const offenders = e2eSources()
      .filter(({ text }) =>
        /\bnew\s+ZodValidationPipe\b|from\s+'nestjs-zod'/.test(stripComments(text)),
      )
      .map(({ file }) => file);

    expect(
      offenders,
      `${offenders.join(', ')} build a validation pipe out of nestjs-zod directly. Use ` +
        '`platformValidationPipe()` from ../../src/bootstrap/validation.pipe — it is the ' +
        'pipe `main.ts` installs, and the only one that answers a DTO violation with an ' +
        'ErrorEnvelope instead of `{statusCode, message:"Validation failed", errors}`.',
    ).toEqual([]);
  });
});

describe('e2e data-root isolation (LoggingModule writes on DI construction)', () => {
  it('DATA_ROOT points at a throwaway dir, never the repo working tree', () => {
    const dataRoot = process.env.DATA_ROOT;

    // Unset is the failure that matters: `env.dataRoot` then falls back to
    // `resolve(cwd, 'data')`, and `RuntimeLogWriter` — constructed by DI the moment
    // any spec boots AppModule — creates `api/data/logs/runtime.log` in the repo.
    // That is the SAME file the local dev server writes, and two processes rotating
    // one log file is how `runtime.log` silently disappears (see _data-root.setup.ts).
    expect(
      dataRoot,
      'DATA_ROOT is unset. The e2e project sets it in `_data-root.setup.ts` via ' +
        '`setupFiles` — if that entry was removed from vitest.workspace.ts, every spec ' +
        "that boots AppModule now writes into the repo's own api/data/.",
    ).toBeDefined();

    expect(
      resolve(dataRoot as string),
      `DATA_ROOT resolves to ${dataRoot}, inside the repo. e2e must never share a data ` +
        'root with the dev server.',
    ).not.toBe(resolve(E2E_DIR, '../../../..', 'data'));
  });
});

/** Drop line/block comments so prose ABOUT the rule never trips the rule. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
