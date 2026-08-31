import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Point DATA_ROOT at a throwaway directory for EVERY e2e file.
 *
 * WHY THIS IS A SETUP FILE AND NOT A `beforeAll` IN EACH SPEC: `LoggingModule` is
 * assembled globally in `AppModule`, and `RuntimeLogWriter` opens its stream in the
 * DI constructor — synchronously, unconditionally, whether or not the spec cares
 * about logging. So the moment a spec does `Test.createTestingModule({imports:[AppModule]})`
 * it touches `${DATA_ROOT}/logs/` on a real disk. 13 e2e specs import AppModule;
 * only a handful set DATA_ROOT themselves. The default is `resolve(cwd, 'data')`
 * — **the same path the local dev server uses**.
 *
 * Two processes writing one `runtime.log` is not a cosmetic problem: each keeps its
 * own in-memory `size` counter, so when one rotates (`rename` runtime.log → .1) the
 * other's stream keeps writing into the RENAMED file and `runtime.log` disappears.
 * That is the exact failure `runtime-log-writer.ts` documents and regression-tests
 * against — this just moves it from intra-process to cross-process, where the
 * writer has no protection at all (no file lock, not even detection).
 *
 * Fixing it per-spec would leave the next new e2e file to rediscover it, so the
 * default is made safe here instead. A spec that wants its own root still wins:
 * setup files run BEFORE `beforeAll`.
 */
const root = mkdtempSync(join(tmpdir(), 'api-e2e-data-'));
process.env.DATA_ROOT = root;

process.on('exit', () => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * 给 e2e 一台**够大的**「宿主机」（03 §3 的配额账本）。
 *
 * ⚠️ 为什么必须在这里做：e2e 的 sandbox 走的是 `_fakes.ts` 的假 provider 与假工作区 ——
 * 它们**不占任何真实资源**，也从不销毁。而配额账本对此一无所知：一台 10 核的开发机按
 * 镜像默认 `resource_defaults`（2 核 / 2048MB）只发得出 6 份配额，于是一个连建 9 个
 * 沙箱的 spec 从第 7 个开始一律 429。那是**账本在正确工作**，不是被测行为出了问题。
 *
 * ⛔ 这里给的是**容量**，不是一个「关掉调度」的开关。开关会让 e2e 完全绕开准入这条路；
 * 容量只是把「这台机器有多大」说清楚，判定逻辑一行都没被跳过 ——
 * `sandbox-capacity.e2e-spec.ts` 反过来把它调小，端到端地钉住 429 那条线。
 *
 * `??=` 而不是直接赋值：某个 spec（比如上面那条）要自己说了算时，它先跑不过 setup ——
 * 但它可以在 `beforeAll` 里覆盖，而覆盖必须能生效。
 */
process.env.SCHEDULER_HOST_CORES ??= '4096';
process.env.SCHEDULER_HOST_RAM_MB ??= '4194304';
