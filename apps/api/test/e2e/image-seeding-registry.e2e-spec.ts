import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type Docker from 'dockerode';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageSpecError, REF_NOT_FOUND, IMAGE_TMUX_MISSING } from '@platform/contracts';
import { ImageApplicationService } from '@platform/image';
import { ManifestInvalidError } from '../../../../packages/modules/image/src/application/image-application.service';
import {
  createDockerClient,
  isDockerAvailable,
} from '../../../../packages/modules/sandbox/src/infrastructure/providers/docker/docker-client';
import { AppModule } from '../../src/app.module';
import { useEnv } from './_env';

/**
 * DOCKER-REQUIRED e2e —— **真实的镜像播种路径**，一个替身都不用。
 *
 * ══ 它补的是一个「错话活了很久」的根因 ═══════════════════════════════════════════
 *
 * ADR 决策 C 曾写着「aio 走 docker 时本地 build 的镜像可直接用、不必 push」。
 * 2026-08-29 在真 Linux 上证伪：`docker build -t platform/sandbox:dev` 之后注册 ⇒
 * `registry registry-1.docker.io answered 401`；push 到自建 registry 后立刻
 * `seeded … (valid)`。
 *
 * ⚠️ **那句错话能活这么久，是因为唯一走 `registerImage` 的那批 e2e 全部**
 * `.overrideProvider(IMAGE_SPEC_REGISTRY).useValue(makeFakeImageSpecRegistry())`
 * **——真实的镜像播种路径没有任何自动化测试覆盖。** 替身当然是对的（十个 e2e 不该
 * 依赖一个可达的 registry），错的是**除了替身之外一条真的都没有**：于是「镜像从哪来」
 * 这个问题在整个测试套件里根本没被问过，文档怎么写都不会红。
 *
 * ⇒ 本文件是那条缺失的路。它**不覆盖** `IMAGE_SPEC_REGISTRY`：真的起一个 registry、
 * 真的 push、真的走 `OciImageSpecProvider` 的 HTTP 往返、真的让 `ImageSeeder` 在
 * `app.init()` 里播种。
 *
 * ══ 正反两个方向，缺一半就钉不死 ═══════════════════════════════════════════════
 *
 * | 方向 | 断言 | 它排除的是 |
 * |---|---|---|
 * | 正 | push 过的镜像 ⇒ 播种成 `valid`，且 digest = **registry 给的那一个** | 「registry 这条路根本不通」 |
 * | 反 | **只存在于 docker daemon**、没 push 的镜像 ⇒ `REF_NOT_FOUND` | 「本地 build 的镜像可直接用」——就是那句错话本身 |
 *
 * ⚠️ 反向那条的**前置断言**同样重要：先确认 `docker.getImage(ref).inspect()` 真的成功
 * （daemon 里确实有这张镜像），否则「注册失败」可能只是因为根本没这张镜像，证明不了
 * 「daemon 有 ≠ 平台能用」。
 *
 * ⚠️ **缺前置就大声跳过，绝不假装通过**（与 `docker-container-runtime.e2e-spec.ts` 同一
 * 套守卫）。跳过时把缺什么、怎么补写清楚——一条 skip 掉的 e2e 从来没有验证过任何东西。
 */
const docker: Docker = createDockerClient();

/**
 * 用来 `docker build` 出测试镜像的底座 —— **内容无关紧要，小就行**；从不自动拉。
 *
 * ⚠️ 为什么要 build 而不是直接 `docker tag` 一张现成的：本文件要复现的场景**就是**
 * 「`docker build` 之后直接注册」，而且根镜像必须声明 `platform.supportedRuntimes`
 * 才不会带 `RUNTIME_NOT_PREINSTALLED` 警告 ⇒ 才落在 `valid` 而不是 `warning`
 * （真镜像 `api/images/platform-sandbox/Dockerfile` 打的正是这个 LABEL）。
 */
const SEED_BASE = process.env.SANDBOX_TEST_SEED_BASE ?? 'alpine:3.20';
/** 起 registry 用的镜像；同样从不自动拉。 */
const REGISTRY_IMAGE = process.env.SANDBOX_TEST_REGISTRY_IMAGE ?? 'registry:2';

const dockerUp = await isDockerAvailable(docker).catch(() => false);
const present = async (ref: string): Promise<boolean> =>
  dockerUp
    ? docker
        .getImage(ref)
        .inspect()
        .then(() => true)
        .catch(() => false)
    : false;
const basePresent = await present(SEED_BASE);
const registryPresent = await present(REGISTRY_IMAGE);
const runnable = dockerUp && basePresent && registryPresent;

if (!runnable) {
  console.warn(
    '\n\x1b[33m========================================================================\n' +
      '[image-seeding-registry.e2e] SKIPPED — 缺前置，本文件一个断言都没跑。\n' +
      `  docker daemon reachable: ${String(dockerUp)}  (DOCKER_HOST=${process.env.DOCKER_HOST ?? 'default socket'})\n` +
      `  image ${REGISTRY_IMAGE} present: ${String(registryPresent)}   ← docker pull ${REGISTRY_IMAGE}\n` +
      `  image ${SEED_BASE} present: ${String(basePresent)}   ← docker pull ${SEED_BASE}\n` +
      '这是平台里唯一一条不走替身的镜像播种路径：跳过 = 「镜像从哪来」这个问题今天没人问。\n' +
      '========================================================================\x1b[0m\n',
  );
}

const TAG = `e2e-${String(process.pid)}`;
const REGISTRY_CONTAINER = `platform-e2e-registry-${String(process.pid)}`;

let registryId = '';
let registryHost = '';
/** push 过的根镜像坐标（斜杠形态，落在平台内置已知镜像表里）。 */
let seededRef = '';
/** 同一张镜像、同一个 registry，**只在 daemon 里打了标签、从没 push**。 */
let neverPushedRef = '';
/** 连字符形态：push 过、但名字不在已知表里（README 的构建目录名叫 platform-sandbox）。 */
let hyphenRef = '';

let app: INestApplication | undefined;
let restoreEnv: (() => void) | undefined;

beforeAll(async () => {
  if (!runnable) return;

  const started = await startRegistry();
  registryId = started.id;
  registryHost = started.host;

  seededRef = `${registryHost}/platform/sandbox:${TAG}`;
  neverPushedRef = `${registryHost}/platform/sandbox:never-pushed-${TAG}`;
  hyphenRef = `${registryHost}/platform-sandbox:${TAG}`;

  // 真的 build 一张（`FROM alpine` + 两个平台 LABEL），再 tag 出另外两个坐标。
  // ⇒ 三个 ref 指向**同一份 bits**，唯一的变量是「push 过没有」和「名字怎么写」。
  await build(seededRef);
  await tag(seededRef, `${registryHost}/platform/sandbox`, `never-pushed-${TAG}`);
  await tag(seededRef, `${registryHost}/platform-sandbox`, TAG);
  await push(seededRef);
  await push(hyphenRef);
  // ⚠️ `neverPushedRef` 故意**不 push**——它就是「本地 build 的镜像」这个反例。

  restoreEnv = useEnv({
    SANDBOX_DEFAULT_IMAGE: seededRef,
    // ⚠️ 必须留空：本文件要走的正是「平台内置已知镜像表」那条路（`platform/sandbox`
    // 在表里），显式声明会把这条路整个短路掉，连字符那条用例也就不再验证任何东西。
    SANDBOX_DEFAULT_IMAGE_TMUX: undefined,
    SANDBOX_AIO_IMAGE: undefined,
    SANDBOX_BOXLITE_IMAGE: undefined,
    IMAGE_REGISTRY_INSECURE_HOSTS: undefined,
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  // `ImageSeeder` 是 `OnApplicationBootstrap` —— 真正的播种发生在这一行里。
  await app.init();
}, 180_000);

afterAll(async () => {
  // ⚠️ **先还原环境，再关 app。** `app.close()` 抛出的话，`restoreEnv` 就再也不会跑，
  // 而 `SANDBOX_DEFAULT_IMAGE` 泄漏到后面每一个 spec 会静默改掉它们的 `ImageSeeder`
  // 播种目标 —— 本轮刚在另外三个文件里抓到过这个形状（见 `suite-hygiene.e2e-spec.ts`）。
  restoreEnv?.();
  await app?.close();
  if (registryId !== '') {
    await docker
      .getContainer(registryId)
      .remove({ force: true })
      .catch(() => undefined);
  }
  for (const ref of [seededRef, neverPushedRef, hyphenRef]) {
    if (ref !== '') {
      await docker
        .getImage(ref)
        .remove({ force: true })
        .catch(() => undefined);
    }
  }
}, 120_000);

describe.skipIf(!runnable)('镜像播种走的是 registry 的 HTTP API（不是 docker daemon）', () => {
  it('⭐ push 过的镜像被 `ImageSeeder` 播成 valid，且 digest 就是 registry 给的那一个', async () => {
    const images = app!.get(ImageApplicationService);
    const row = (await images.listImages()).find((i) => i.ref === seededRef);
    expect(
      row,
      `ImageSeeder 没有播种 ${seededRef}。这条红了说明真实的播种路径断了——而套件里其他` +
        '所有走 registerImage 的 e2e 都用替身，谁都不会替你报出来。',
    ).toBeDefined();
    expect(row!.isBuiltin).toBe(true);
    expect(row!.validationStatus).toBe('valid');

    // ⚠️ **digest 必须与 registry 自己回答的一致。** 这一条把「平台是从 registry 拿的」
    // 与「平台从别处编了一个 digest」区分开——后者正是 `'sha256:unresolved'` 那个时代
    // 的形状，它当时也是「有值、看起来对」。
    const advertised = await registryDigest(registryHost, 'platform/sandbox', TAG);
    expect(row!.digest).toBe(advertised);
  });

  it('⭐ 只存在于 docker daemon、没 push 的镜像被拒 —— 「本地 build 可直接用」是错的', async () => {
    // 前置：daemon 里**确实**有这张镜像。少了这一句，下面的失败可能只是「压根没这张
    // 镜像」，证明不了「daemon 有 ≠ 平台能用」——而那正是这条用例唯一要证的事。
    await expect(
      docker.getImage(neverPushedRef).inspect(),
      `${neverPushedRef} 不在本机 docker 镜像库里，这条用例的前置不成立`,
    ).resolves.toBeDefined();

    const thrown = await app!
      .get(ImageApplicationService)
      .registerImage(neverPushedRef, { builtin: true })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(thrown, '注册一张没 push 过的镜像居然成功了').toBeInstanceOf(ImageSpecError);
    expect((thrown as ImageSpecError).code).toBe(REF_NOT_FOUND);
  });

  it('⭐ 同一张 bits、同一个 registry：区别只有 push 过没有', async () => {
    // 两个 ref 指向**完全相同的本地镜像**（同一次 `docker tag`），仓库名也一样，
    // 只有 tag 不同、其中一个 push 过。⇒ 通过与不通过之间唯一的变量就是 push。
    const seeded = (await app!.get(ImageApplicationService).listImages()).find(
      (i) => i.ref === seededRef,
    );
    expect(seeded).toBeDefined();
    const local = await docker.getImage(neverPushedRef).inspect();
    const pushed = await docker.getImage(seededRef).inspect();
    expect(local.Id).toBe(pushed.Id);
  });
});

describe.skipIf(!runnable)('镜像名的隐形约束：斜杠 vs 连字符', () => {
  it('⭐ `platform-sandbox`（连字符，= 构建目录名）被拒，且错误自己说得出正确形态', async () => {
    // 它 **push 过**，所以第一关（registry）是通的——被拒的原因只可能是名字。
    const thrown = await app!
      .get(ImageApplicationService)
      .registerImage(hyphenRef, { builtin: true })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ManifestInvalidError);
    const findings = (thrown as ManifestInvalidError).outcome.errors;
    expect(findings.map((f) => f.code)).toContain(IMAGE_TMUX_MISSING);
    const message = findings.map((f) => f.message).join('\n');
    // ⚠️ 这条约束此前**只存在于一张表里，没有任何地方提示**：照 README 的构建目录名
    // build 出来的镜像会被拒，而消息里一个字都没提到名字。
    expect(message).toContain('platform/sandbox');
    expect(message).toContain('只差一个分隔符');
  });
});

/**
 * 起一个真的 registry，并回答**平台侧该用哪个坐标**。
 *
 * ⚠️⚠️ **端口必须是固定号，不能用内核分配的临时端口 —— 实测踩到，而它正是本轮的病根。**
 * `docker push` 是 **daemon** 发起的，而 daemon 不一定与本进程共享 netns：Docker
 * Desktop 把它放在一个 VM 里。实测同一台机器上：
 *
 * | 发布方式 | 宿主 `curl http://127.0.0.1:<port>/v2/` | `docker push 127.0.0.1:<port>/…` |
 * |---|---|---|
 * | `-p 5199:5000`（固定号） | 200 | ✅ Pushed |
 * | `-p 0.0.0.0::5000`（内核分配） | 200 | ⛔ `connect: connection refused` |
 *
 * 也就是说**「宿主够得着」不蕴含「daemon 够得着」**——与 §1.4 那个「容器 healthy、
 * 平台连不上」是同一句话的两种说法，只是这次踩到它的是测试脚手架自己。
 *
 * ⇒ 从一个固定号开始试，被占就换下一个。0.0.0.0 是为了让 daemon 那一侧也解析得开；
 * 平台侧仍走 `127.0.0.1:<port>`（明文 http 只认 loopback 字面量）。
 */
async function startRegistry(): Promise<{ id: string; host: string }> {
  const first = 51500 + (process.pid % 300);
  let last: unknown;
  for (let port = first; port < first + 20; port++) {
    try {
      const container = await docker.createContainer({
        name: `${REGISTRY_CONTAINER}-${String(port)}`,
        Image: REGISTRY_IMAGE,
        Labels: { 'platform.test': 'true' },
        ExposedPorts: { '5000/tcp': {} },
        HostConfig: {
          PortBindings: { '5000/tcp': [{ HostIp: '0.0.0.0', HostPort: String(port) }] },
        },
      });
      try {
        await container.start();
      } catch (e) {
        await container.remove({ force: true }).catch(() => undefined);
        throw e;
      }
      const host = `127.0.0.1:${String(port)}`;
      await waitForRegistry(host);
      return { id: container.id, host };
    } catch (e) {
      last = e;
    }
  }
  throw new Error(
    `could not start a test registry on ports ${String(first)}..${String(first + 19)}: ${
      last instanceof Error ? last.message : String(last)
    }`,
  );
}

/** registry 就绪 —— `/v2/` 回 200 才算起来了。 */
async function waitForRegistry(host: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${host}/v2/`);
      if (res.ok) return;
      last = `HTTP ${String(res.status)}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`registry at ${host} never became ready (${last})`);
}

/** registry **自己**回答的 manifest digest —— 平台那一份必须与它一致。 */
async function registryDigest(
  host: string,
  repository: string,
  reference: string,
): Promise<string> {
  const res = await fetch(`http://${host}/v2/${repository}/manifests/${reference}`, {
    headers: {
      accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ].join(', '),
    },
  });
  if (!res.ok) throw new Error(`registry answered ${String(res.status)} for ${repository}`);
  const digest = res.headers.get('docker-content-digest');
  if (digest === null) throw new Error('registry did not advertise a Docker-Content-Digest');
  return digest;
}

/**
 * `docker build` 一张最小的「平台预制镜像」—— 复现的正是真机上那次操作。
 *
 * LABEL 与 `api/images/platform-sandbox/Dockerfile` 同源：`supportedRuntimes` 决定
 * `validate()` 会不会挂 `RUNTIME_NOT_PREINSTALLED` 警告，也就决定播种落在 `valid`
 * 还是 `warning`。
 */
async function build(ref: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'platform-e2e-image-'));
  try {
    writeFileSync(
      join(dir, 'Dockerfile'),
      `FROM ${SEED_BASE}\nLABEL platform.supportedRuntimes="codex,claude-code"\nLABEL platform.tmux="true"\n`,
    );
    await drain(await docker.buildImage({ context: dir, src: ['Dockerfile'] }, { t: ref }), ref);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function tag(source: string, repo: string, tagName: string): Promise<void> {
  await docker.getImage(source).tag({ repo, tag: tagName });
}

/** 真的 push —— 失败必须抛，不许静默。 */
async function push(ref: string): Promise<void> {
  await drain(await docker.getImage(ref).push({ authconfig: {} }), ref);
}

/**
 * 等一条 docker 进度流跑完，**并把流里的错误当成失败**。
 *
 * ⚠️ build / push 的失败**不在 HTTP 状态码上**：daemon 回 200，错误以
 * `{"errorDetail":…}` 的形式出现在流的中途。只 `await` 不检查 ⇒ 一次失败的 push 会
 * 静静地当成成功，然后本文件的正向用例会红在一个毫不相干的地方（「怎么没播种」）。
 */
async function drain(stream: NodeJS.ReadableStream, what: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null, output: { error?: string; errorDetail?: { message?: string } }[]) => {
        if (err) return reject(err);
        const failed = output.find((o) => o.error !== undefined || o.errorDetail !== undefined);
        if (failed) {
          return reject(
            new Error(
              `docker stream for ${what} failed: ${failed.error ?? failed.errorDetail?.message ?? '?'}`,
            ),
          );
        }
        resolve();
      },
    );
  });
}
