import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobHandle, SandboxHandle, SandboxProvider } from '@platform/contracts';
import {
  createDockerClient,
  isDockerAvailable,
} from '../../../../packages/modules/sandbox/src/infrastructure/providers/docker/docker-client';
import { AioSandboxProvider } from '../../../../packages/modules/sandbox/src/infrastructure/providers/aio/aio-sandbox.provider';
import { BoxliteSandboxProvider } from '../../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-sandbox.provider';
import { closeAllJobStreams } from '../../../../packages/modules/sandbox/src/infrastructure/providers/aio/aio-sandbox-agent.client';

/**
 * HOST-REQUIRED e2e for the JOB and FILE planes (04 §2.6), run against a REAL sandbox
 * on BOTH built-in providers.
 *
 * Everything here goes through the real `provider.jobs` / `provider.files`, never
 * `docker exec` — because the failures this file exists to catch are all failures of
 * the platform's OWN path:
 *
 *   ① the three-step ordering (create session → exec async → attach socket). Written
 *      the intuitive way round it works perfectly until the first platform restart,
 *      when the socket takes the session — and the job — down with it.
 *   ② a disconnect must lose NOTHING: the gap is filled by ONE cursor read, and the
 *      same read is what fills the gap between the start and the first attach.
 *   ③ `killJob` must NOT release — the exit code and the tail are what a caller reads
 *      after killing something.
 *   ④ SP-J1 生存义务: a job nobody reads for a long time must STILL be readable and
 *      still report its exit code. The backing agent reaps idle sessions on a clock
 *      that reading does NOT refresh, so this is the clause a naive implementation
 *      breaks by default.
 *
 * Skips LOUDLY when the host or the image is missing — never a silent fake pass.
 */
const DOCKER_IMAGE = process.env.SANDBOX_TEST_IMAGE ?? 'ghcr.io/agent-infra/sandbox:latest';
const BOXLITE_REGISTRY = process.env.SANDBOX_BOXLITE_REGISTRY ?? 'localhost:5001';
const BOXLITE_IMAGE =
  process.env.SANDBOX_BOXLITE_TEST_IMAGE ?? `${BOXLITE_REGISTRY}/agent-infra/sandbox:latest`;

/**
 * How long the SP-J1 job runs while NOBODY reads it. It is deliberately far shorter
 * than the sandbox agent's default idle TTL — this test is not trying to wait out an
 * hour, it is proving the platform RAISED that TTL at create time and that the job is
 * still readable after a long silence. The TTL itself is asserted directly below.
 */
const SURVIVAL_SILENCE_MS = 20_000;

const SANDBOX_PKG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/modules/sandbox/package.json',
);
const requireFromSandbox = createRequire(SANDBOX_PKG);

function boxliteBinaryPresent(): boolean {
  try {
    requireFromSandbox('@boxlite-ai/boxlite');
    return true;
  } catch {
    return false;
  }
}

async function registryServingImage(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`http://${BOXLITE_REGISTRY}/v2/agent-infra/sandbox/tags/list`, {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const body = (await res.json()) as { tags?: string[] };
    return Array.isArray(body.tags) && body.tags.includes('latest');
  } catch {
    return false;
  }
}

const docker = createDockerClient();
const dockerUp = await isDockerAvailable(docker).catch(() => false);
const dockerImagePresent = dockerUp
  ? await docker
      .getImage(DOCKER_IMAGE)
      .inspect()
      .then(() => true)
      .catch(() => false)
  : false;
const aioReady = dockerUp && dockerImagePresent;
const boxliteReady = boxliteBinaryPresent() && (await registryServingImage());

if (!aioReady || !boxliteReady) {
  console.warn(
    '\n\x1b[33m========================================================================\n' +
      '[agent-task-job-plane.e2e] PARTIALLY SKIPPED — host prerequisites missing:\n' +
      `  aio      (docker up: ${dockerUp}, image ${DOCKER_IMAGE}: ${dockerImagePresent})\n` +
      `  boxlite  (binary + ${BOXLITE_REGISTRY} serving the AIO image): ${boxliteReady}\n` +
      'This is the ONLY proof that the job/file planes work against a real sandbox.\n' +
      '========================================================================\x1b[0m\n',
  );
}

interface Target {
  label: string;
  ready: boolean;
  provider: SandboxProvider;
  image: string;
}

const targets: Target[] = [
  { label: 'aio', ready: aioReady, provider: new AioSandboxProvider(docker), image: DOCKER_IMAGE },
  {
    label: 'boxlite',
    ready: boxliteReady,
    provider: new BoxliteSandboxProvider(),
    image: BOXLITE_IMAGE,
  },
];

afterAll(() => {
  // a live attachment keeps the event loop busy and would hang the runner.
  closeAllJobStreams();
});

for (const target of targets) {
  describe.skipIf(!target.ready)(`job + file planes on a real ${target.label} sandbox`, () => {
    const provider = target.provider;
    let handle: SandboxHandle;

    beforeAll(async () => {
      handle = await provider.create({
        sandboxId: `e2e-jobs-${target.label}-${process.pid}`,
        quota: { cores: 2, ramMb: 2048, diskMb: 4096 },
        image: { ref: target.image, digest: 'sha256:e2e' },
        env: {},
        labels: { 'platform.test': 'true' },
      });
      await provider.start(handle);
    }, 600_000);

    afterAll(async () => {
      if (handle) await provider.destroy(handle).catch(() => undefined);
    });

    it('CAP-02: the capability bit and the two planes agree', () => {
      expect(provider.capabilities.headlessTask).toBe(true);
      expect(provider.jobs).toBeDefined();
      expect(provider.files).toBeDefined();
    });

    /**
     * 生存义务（04 §2.6 ★★★）—— **两个 provider 兑现它的方式不同，所以断言也不同。**
     *
     * ⚠️ 这条**曾经对两边写同一句**（「session TTL 与上限必须在 create 时拉高」），
     * 那是因为当时 boxlite 复用 aio 的 data-plane 客户端，两边真的跑同一个 agent。
     * 数据面拆开之后再照抄，就是在要求 native 那侧去满足一个它根本没有的机制——
     * 决策 A 修订里那句「共享实现保证的是『两边一样』，一旦对某个 provider 不适用，
     * 『一样』就变成一起错」，在测试里的形态就是这条。
     *
     * 义务本身没变，**验证它的证据**变了：
     *   aio     → agent 的 session 有 IDLE TTL（默认 3600s，读输出不刷新它的时钟）
     *              与 session 上限（默认 50，新建淘汰最老的），两者都在 agent **启动时**
     *              读取 ⇒ 只能在 `create()` 设，所以断言沙箱**真的**用这套 env 起来了。
     *   boxlite → 根本没有 session：作业由 `setsid` 放进**自己的会话**，输出落 box 内
     *              文件。所以证据是「跑起来的进程确实是一个新 session 的 leader」
     *              （`sid == pgid == pid`），以及**没有**注入那两个 env——注入了反而说明
     *              有人把 agent 那套又搬回来了。
     */
    const shellOut = async (script: string): Promise<string> => {
      const stream = await provider.spawn(handle, { cmd: ['sh', '-c', script], tty: false });
      return new Promise<string>((resolveOut) => {
        let acc = '';
        stream.onData((c) => {
          acc += c.toString('utf8');
        });
        stream.onExit(() => resolveOut(acc));
      });
    };

    it('生存义务: 用这一档自己的机制兑现，并有对应的证据', async () => {
      const env = (
        await shellOut('printf "%s|%s" "$BASH_SESSION_TIMEOUT" "$MAX_BASH_SESSIONS"')
      ).trim();
      if (target.label === 'aio') {
        const [ttl, cap] = env.split('|');
        // comfortably beyond the longest tier a Task may ask for (240 minutes).
        expect(Number(ttl)).toBeGreaterThanOrEqual(240 * 60);
        expect(Number(cap)).toBeGreaterThan(50);
        return;
      }
      // native 侧：不该有那两个 env（有 = agent 那套又爬回来了）。
      expect(env).toBe('|');
      // 起一个后台作业，然后从 box 内部看它的进程属性：sid == pgid == pid 才叫
      // 「自己的会话」——那正是「读的人走了、平台重启了，进程也不受影响」的物理基础。
      const job = await provider.jobs!.startJob(handle, {
        cmd: ['sh', '-c', 'sleep 30'],
      });
      try {
        const probe = (
          await shellOut(
            'p=$(cat /var/tmp/.platform-job-*/pgid 2>/dev/null | head -1); ' +
              'ps -o pid= -o pgid= -o sid= -p "$p" 2>/dev/null | tr -s " "',
          )
        ).trim();
        const [pid, pgid, sid] = probe.replace(/^\s+/, '').split(' ');
        expect(pid).not.toBe('');
        expect(pgid).toBe(pid);
        expect(sid).toBe(pid);
      } finally {
        await provider.jobs!.killJob(handle, job);
        await provider.jobs!.releaseJob(handle, job);
      }
    }, 120_000);

    it('async 起 → 收流 → 断开 → 补洞 → 重新附着 → 杀 → 释放', async () => {
      const jobs = provider.jobs!;
      // A job that prints a marker per second, so the gap between reads is REAL output
      // rather than a contrived pause.
      const job: JobHandle = await jobs.startJob(handle, {
        cmd: ['sh', '-c', 'i=0; while [ $i -lt 60 ]; do i=$((i+1)); echo "TICK$i"; sleep 1; done'],
        timeoutMs: 120_000,
      });
      expect(job.provider).toBe(provider.name);
      expect(job.jobId).toBeTruthy();

      // ① first read — this is ALSO the 首段补洞: everything the job wrote between the
      // start and this moment, which no socket could have seen.
      const first = await jobs.readJob(handle, job, undefined, { waitMs: 15_000 });
      expect(first.status).toBe('running');
      expect(first.stdout).toContain('TICK1');
      // whole lines only: a half line would be an unparseable fragment downstream.
      expect(first.stdout.endsWith('\n')).toBe(true);

      // ② drop every attachment — the platform "crashing" as far as the sandbox knows.
      closeAllJobStreams();
      await new Promise((r) => setTimeout(r, 3_000));

      // ③ 补洞 + 重新附着, through the SAME call. Nothing produced during the gap is
      // lost, because the cursor — not the socket — is the authority.
      const second = await jobs.readJob(handle, job, first.cursor, { waitMs: 15_000 });
      expect(second.status).toBe('running');
      expect(second.stdout).not.toBe('');
      // no repeat across the reconnect: the cursor advanced past what was delivered.
      expect(second.stdout).not.toContain('TICK1\n');

      // ④ kill — and read AFTERWARDS, which is the whole reason kill does not release.
      await jobs.killJob(handle, job, 'SIGTERM');
      const afterKill = await jobs.readJob(handle, job, second.cursor, { waitMs: 10_000 });
      expect(afterKill.status).toBe('exited');
      // the tail is still there and the session still answers.
      const replay = await jobs.readJob(handle, job, undefined, {});
      expect(replay.stdout).toContain('TICK1');

      // ⑤ release LAST — after that the sandbox-side state is gone for good.
      await jobs.releaseJob(handle, job);
    }, 300_000);

    it('SP-J1 生存义务: a job nobody reads for a long time still yields output AND its exit code', async () => {
      const jobs = provider.jobs!;
      const seconds = Math.ceil(SURVIVAL_SILENCE_MS / 1000);
      const job = await jobs.startJob(handle, {
        cmd: ['sh', '-c', `sleep ${seconds}; echo DONE-LATE; exit 7`],
        timeoutMs: SURVIVAL_SILENCE_MS * 4,
      });

      // ⚠️ NOT A SINGLE READ while it runs. Polling would be the wrong test: the agent's
      // reaper clock is NOT refreshed by reading, so a version of this test that polled
      // would pass even against an implementation that never raised the TTL.
      await new Promise((r) => setTimeout(r, SURVIVAL_SILENCE_MS + 5_000));

      const chunk = await jobs.readJob(handle, job, undefined, {});
      expect(chunk.status).toBe('exited');
      expect(chunk.stdout).toContain('DONE-LATE');
      expect(chunk.exitCode).toBe(7);
      await jobs.releaseJob(handle, job);
    }, 300_000);

    it('平台重启: a handle+cursor rebuilt from PERSISTED strings resumes the same job', async () => {
      const jobs = provider.jobs!;
      const job = await jobs.startJob(handle, {
        cmd: ['sh', '-c', 'echo BEFORE; sleep 3; echo AFTER; exit 0'],
        timeoutMs: 60_000,
      });
      const before = await jobs.readJob(handle, job, undefined, { waitMs: 10_000 });
      expect(before.stdout).toContain('BEFORE');

      // ── the restart: everything in memory is discarded and the ONLY inputs are the
      // two strings a database row would have held. ──────────────────────────────────
      const persistedJob: JobHandle = JSON.parse(JSON.stringify(job)) as JobHandle;
      const persistedCursor: string = JSON.parse(JSON.stringify(before.cursor)) as string;
      const persistedHandle: SandboxHandle = JSON.parse(JSON.stringify(handle)) as SandboxHandle;
      closeAllJobStreams();

      const after = await jobs.readJob(persistedHandle, persistedJob, persistedCursor, {
        waitMs: 20_000,
      });
      expect(after.stdout).toContain('AFTER');
      // and it continued rather than starting over.
      expect(after.stdout).not.toContain('BEFORE');
      const final =
        after.status === 'exited'
          ? after
          : await jobs.readJob(persistedHandle, persistedJob, after.cursor, { waitMs: 15_000 });
      expect(final.status).toBe('exited');
      expect(final.exitCode).toBe(0);
      await jobs.releaseJob(persistedHandle, persistedJob);
    }, 300_000);

    it('the file plane: binary round trip, a missing file is null, and a listing normalises', async () => {
      const files = provider.files!;
      const bytes = Buffer.from([0x00, 0xa3, 0xff, 0x10, 0x80, 0x0a]);
      await files.writeFile(handle, '/tmp/e2e-artifacts/blob.bin', bytes);
      const back = await files.readFile(handle, '/tmp/e2e-artifacts/blob.bin');
      expect(back).not.toBeNull();
      // byte-for-byte: the agent's TEXT read endpoint cannot do this at all (it raises
      // a utf-8 decode error), which is why the plane is backed by the download route.
      expect(Buffer.compare(back!, bytes)).toBe(0);

      // a missing file is a NORMAL answer, not a fault — codex's output-last-message
      // file simply does not exist when a task fails.
      expect(await files.readFile(handle, '/tmp/e2e-artifacts/nope.bin')).toBeNull();
      expect(await files.openFileStream(handle, '/tmp/e2e-artifacts/nope.bin')).toBeNull();

      await files.writeFile(handle, '/tmp/e2e-artifacts/note.txt', 'hello\n');
      // ⚠️ A NESTED FILE, so the listing really CONTAINS a directory. Without it the
      // `kind === 'dir'` assertion below was reachable zero times — a green check on a
      // branch that never ran, which is worse than no check at all: it is the one
      // normalisation (the agent reports `size: null` for a directory, which must come
      // back ABSENT rather than 0) that nothing else covers.
      await files.writeFile(handle, '/tmp/e2e-artifacts/sub/deep.txt', 'nested\n');
      const listed = await files.listFiles(handle, '/tmp/e2e-artifacts', { recursive: true });
      const names = listed.map((e) => e.path);
      expect(names).toContain('/tmp/e2e-artifacts/blob.bin');
      expect(names).toContain('/tmp/e2e-artifacts/note.txt');
      const dirs = listed.filter((e) => e.kind === 'dir');
      expect(dirs.length).toBeGreaterThan(0);
      for (const entry of listed) {
        // the agent reports epoch SECONDS in a STRING; the provider normalises to ISO.
        expect(entry.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        if (entry.kind === 'dir') expect(entry.size).toBeUndefined();
      }

      const stream = await files.openFileStream(handle, '/tmp/e2e-artifacts/note.txt');
      expect(stream).not.toBeNull();
      const streamed = await new Promise<string>((res) => {
        let acc = '';
        stream!.on('data', (c: Buffer) => {
          acc += c.toString('utf8');
        });
        stream!.on('end', () => res(acc));
      });
      expect(streamed).toBe('hello\n');
    }, 180_000);

    it('stderr reaches the platform even when stdout is EMPTY (the failure path)', async () => {
      // The measured failure shape: codex writes ZERO bytes to stdout and puts the whole
      // explanation on stderr. If stderr were left on the session's own channel — which
      // the streaming socket never forwards — this case would arrive as silence.
      const jobs = provider.jobs!;
      const job = await jobs.startJob(handle, {
        cmd: ['sh', '-c', 'echo "boom: no rollout found" 1>&2; exit 1'],
        timeoutMs: 60_000,
      });
      let chunk = await jobs.readJob(handle, job, undefined, { waitMs: 15_000 });
      if (chunk.status !== 'exited') {
        chunk = await jobs.readJob(handle, job, chunk.cursor, { waitMs: 15_000 });
      }
      expect(chunk.status).toBe('exited');
      expect(chunk.exitCode).toBe(1);
      // ⚠️ EXACTLY THE JOB'S OWN BYTES. `/v1/bash/output` replays the SESSION's recorded
      // output from an offset and a `command_id` does NOT scope it, so anything the
      // platform runs in this session before the job (the scratch `mkdir`, the survival
      // probe) would arrive here as the job's first stdout and be fed to `parseOutput`.
      expect(chunk.stdout).toBe('');
      expect(chunk.stderr).toContain('no rollout found');
      await jobs.releaseJob(handle, job);
    }, 180_000);

    it('the sandbox-side hard timeout really kills, and reports the platform’s 124', async () => {
      const jobs = provider.jobs!;
      const job = await jobs.startJob(handle, {
        cmd: ['sh', '-c', 'sleep 120'],
        timeoutMs: 3_000,
      });
      let chunk = await jobs.readJob(handle, job, undefined, { waitMs: 20_000 });
      for (let i = 0; i < 5 && chunk.status !== 'exited'; i++) {
        chunk = await jobs.readJob(handle, job, chunk.cursor, { waitMs: 10_000 });
      }
      expect(chunk.status).toBe('exited');
      // 124 is the platform's agreed spelling of "the sandbox-side hard timeout fired"
      // (03 §8.3) — distinguishable from an ordinary non-zero exit.
      expect(chunk.exitCode).toBe(124);
      await jobs.releaseJob(handle, job);
    }, 180_000);
  });
}
