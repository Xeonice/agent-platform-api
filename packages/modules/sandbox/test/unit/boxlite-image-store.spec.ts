import { describe, it, expect } from 'vitest';
import {
  isImageStaged,
  normaliseStoreReference,
  imageStageProgress,
} from '../../src/infrastructure/providers/boxlite/boxlite-image-store';

/**
 * 「本机是不是已经有这份镜像」的判定 —— `sandbox.instance_progress.imageStaged` 的唯一
 * 输入，也是那 190 秒里前端唯一说得出口的**理由**。
 *
 * ⚠️ 本文件里的每一条 fixture 都是**实测抄下来的**，不是照着字段名想出来的：
 * 2026-08-28 直接读 `~/.boxlite/db/boxlite.db` 的 `image_index` 表（只读拷贝，没碰
 * BOXLITE_HOME 的锁）。这很重要 —— 两种「看起来对」的键都是错的，光看类型定义
 * (`ImageInfo { reference, repository, tag, id, … }`) 一个都发现不了：
 *
 *   · 按 digest 配：那行 `platform/sandbox:v2@sha256:ee84dd…` 的 `manifest_digest` 是
 *     `sha256:25645ad6…`，**和 reference 里的那个 digest 不是一个东西**（前者是解出来的
 *     单架构 manifest，后者是平台钉的多架构 index）。按 digest 永远配不上。
 *   · 按 repository+tag 配：digest 钉住的那种 pull，整条 `name:tag@sha256:…` 就是主键，
 *     没有一个干净的 tag 半边可比。
 *
 * 真正的键是 store 收到的那个**引用字符串原样**，而平台交出去的就是
 * `pinnedImageRef(spec)`。所以这里比的就是它。
 */

/** 实测行（`select reference from image_index`，2026-08-28，逐字抄写）。 */
const REAL_STORE = [
  { reference: 'docker.io/library/alpine:latest' },
  { reference: 'docker.io/library/debian:bookworm-slim' },
  { reference: 'docker.io/alpine/git:latest' },
  { reference: 'localhost:5001/agent-infra/sandbox:latest' },
  {
    reference:
      'localhost:5001/agent-infra/sandbox:latest@sha256:5ca2cd5619ee1e18c5479301e740c1e35307ce85d4142a145aec65d459655eee',
  },
  {
    reference:
      'localhost:5001/platform/sandbox:v2@sha256:ee84dd3ba31a6e9cc80ba215788358470c8600a16f5d26b23a223358d93a3389',
  },
];

/** 用户那次 190 秒等待里真正被拉的那份镜像。 */
const SANDBOX_V2 = {
  ref: 'localhost:5001/platform/sandbox:v2',
  digest: 'sha256:ee84dd3ba31a6e9cc80ba215788358470c8600a16f5d26b23a223358d93a3389',
};

describe('isImageStaged —— digest 钉住的引用（平台的常规路径，04 §7 时刻④）', () => {
  it('命中：store 里存的就是 `ref@digest` 原样', () => {
    expect(isImageStaged(REAL_STORE, SANDBOX_V2)).toBe(true);
  });

  it('未命中：同名同 tag 但 digest 不同 —— 那是另一份位，还是要现拉', () => {
    // `:v2` 被重新推过一次的情形。前端据此说「本机还没有这个镜像」，是对的。
    expect(
      isImageStaged(REAL_STORE, {
        ...SANDBOX_V2,
        digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      }),
    ).toBe(false);
  });

  it('未命中：store 里一行都没有', () => {
    expect(isImageStaged([], SANDBOX_V2)).toBe(false);
  });

  it('不拿 manifest_digest 当键 —— 实测它和 reference 里的 digest 不是同一个值', () => {
    // 这条盯的是一个**看起来完全合理**的实现：`entries.some(e => e.id === image.digest)`。
    // 实测那行的 manifest_digest 是 sha256:25645ad6…，reference 里是 sha256:ee84dd…。
    // 所以只给 digest、不给 reference 的一行，必须判为未命中。
    const digestOnlyRow = [
      { reference: 'sha256:25645ad64b43f90d06b5e079effdda315cfcaf1c2813ee08b666ef344d41660f' },
    ];
    expect(isImageStaged(digestOnlyRow, SANDBOX_V2)).toBe(false);
  });
});

describe('isImageStaged —— 退化成裸 tag 的引用（digest 没解出来的老沙箱行）', () => {
  it('命中一个 docker.io 归一化过的行：`alpine` ↔ `docker.io/library/alpine:latest`', () => {
    // 少了这一步归一化，最老的那批沙箱会被告知「本机没有这个镜像」——而它就在那儿。
    expect(isImageStaged(REAL_STORE, { ref: 'alpine', digest: '' })).toBe(true);
    expect(isImageStaged(REAL_STORE, { ref: 'alpine:latest', digest: '' })).toBe(true);
  });

  it('命中一个带命名空间的 docker.io 行：`alpine/git:latest`', () => {
    // `library/` 只补给单段名字；给 `alpine/git` 补上会拼出一个谁都配不上的串。
    expect(isImageStaged(REAL_STORE, { ref: 'alpine/git:latest', digest: '' })).toBe(true);
  });

  it('本机 mirror 的裸 tag 原样命中，不被塞进 docker.io', () => {
    expect(
      isImageStaged(REAL_STORE, { ref: 'localhost:5001/agent-infra/sandbox:latest', digest: '' }),
    ).toBe(true);
  });

  it('digest 是占位字符串时按裸 tag 走（`pinnedImageRef` 的降级路径）', () => {
    expect(
      isImageStaged(REAL_STORE, { ref: 'docker.io/library/alpine:latest', digest: 'not-a-digest' }),
    ).toBe(true);
  });
});

describe('normaliseStoreReference —— 只在裸 tag 那条路上动手', () => {
  it.each([
    ['alpine', 'docker.io/library/alpine:latest'],
    ['alpine:3.20', 'docker.io/library/alpine:3.20'],
    ['alpine/git:latest', 'docker.io/alpine/git:latest'],
    ['ghcr.io/foo/bar:v1', 'ghcr.io/foo/bar:v1'],
    ['localhost:5001/platform/sandbox:v2', 'localhost:5001/platform/sandbox:v2'],
  ])('%s → %s', (input, expected) => {
    expect(normaliseStoreReference(input)).toBe(expected);
  });

  it('带 digest 的引用原样返回 —— 给它补 `docker.io/` 会造出一个配不上任何行的串', () => {
    const pinned = `localhost:5001/platform/sandbox:v2@${SANDBOX_V2.digest}`;
    expect(normaliseStoreReference(pinned)).toBe(pinned);
  });

  it('`localhost` 不带端口时也算 registry host，不补 docker.io', () => {
    // 它既没有点也没有冒号，是唯一一个必须靠名字认出来的 host。
    expect(normaliseStoreReference('localhost/platform/sandbox:v2')).toBe(
      'localhost/platform/sandbox:v2',
    );
  });
});

const join = (...p: string[]): string => p.join('/');

/**
 * `imageStageProgress` —— 按**这张镜像自己的清单**量进度。
 *
 * ⚠️ 这里读的是 **BoxLite 的私有目录布局**，SDK 没暴露它。用例把这份耦合钉出来，
 * 好让哪天升级挪了目录时，红的是它而不是用户屏幕上那条不动的条。
 *
 * ⛔ 它取代的旧算法是「全店字节 − 调用开始时的基线」。下面前两条用例钉的正是**那套算法
 * 栽过的两个坑**（2026-09-14 真机）：缓存缩水导致读数为负被钉死在 0；以及分子排除了
 * 已缓存的层而分母是整张镜像。
 */
describe('imageStageProgress', () => {
  const INDEX = 'sha256:aa';
  const ARM = 'sha256:bb';
  const AMD = 'sha256:cc';

  /** 8 层里挑 3 层够说明问题：一个大层 + 两个小层。 */
  const armManifest = {
    layers: [
      { digest: 'sha256:L1', size: 100 },
      { digest: 'sha256:L2', size: 200 },
      { digest: 'sha256:BIG', size: 700 },
    ],
  };

  const make = (onDisk: Record<string, number>, manifests?: Record<string, unknown>) => ({
    readFile: (p: string): Promise<string> => {
      const name = p.split('/').pop() ?? '';
      const table: Record<string, unknown> = manifests ?? {
        'sha256-aa.json': {
          manifests: [
            { digest: AMD, platform: { architecture: 'amd64', os: 'linux' } },
            { digest: ARM, platform: { architecture: 'arm64', os: 'linux' } },
          ],
        },
        'sha256-bb.json': armManifest,
        'sha256-cc.json': { layers: [{ digest: 'sha256:X', size: 999999 }] },
      };
      const doc = table[name];
      return doc === undefined
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve(JSON.stringify(doc));
    },
    stat: (p: string): Promise<{ size: number }> => {
      const name = p.split('/').pop() ?? '';
      const size = onDisk[name];
      return size === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve({ size });
    },
  });

  it('⭐ 缓存缩水（半截层被丢弃）⇒ 读数**跟着下降**，⛔ 不是钉死在 0', async () => {
    // 大层下到 400 字节时被丢弃 ⇒ 磁盘上只剩两个小层。
    const before = await imageStageProgress(
      '/home',
      INDEX,
      'arm64',
      make({ 'sha256-L1.tar.gz': 100, 'sha256-L2.tar.gz': 200, 'sha256-BIG.tar.gz': 400 }),
      join,
    );
    const after = await imageStageProgress(
      '/home',
      INDEX,
      'arm64',
      make({ 'sha256-L1.tar.gz': 100, 'sha256-L2.tar.gz': 200 }),
      join,
    );
    expect(before?.have).toBe(700);
    // ⛔ 旧算法在这里会变负、被 `Math.max(0, …)` 钉死在 0，于是界面「卡在 1%」而磁盘上
    //    明明有两层。新算法如实说 300 —— 它恰好告诉用户「刚才那一层白下了」。
    expect(after?.have).toBe(300);
    expect(after?.total).toBe(1000);
  });

  it('⭐ 分子分母**同源**：已缓存的层算进分子，⛔ 不被排除在外', async () => {
    // 三层里已有两层落盘：30% —— 旧算法在续传时会把它算成接近 0%。
    const got = await imageStageProgress(
      '/home',
      INDEX,
      'arm64',
      make({ 'sha256-L1.tar.gz': 100, 'sha256-L2.tar.gz': 200 }),
      join,
    );
    expect(got).toEqual({ have: 300, total: 1000 });
  });

  it('⭐ 多架构 index ⇒ 取**本机架构**那一份，⛔ 不许拿第一个充数', async () => {
    // amd64 那份只有一层 999999 字节；取错了 total 就是错的。
    const arm = await imageStageProgress('/home', INDEX, 'arm64', make({}), join);
    const amd = await imageStageProgress('/home', INDEX, 'amd64', make({}), join);
    expect(arm?.total).toBe(1000);
    expect(amd?.total).toBe(999999);
  });

  it('⛔ 本机架构不在 index 里 ⇒ null（「我量不了」），⛔ 不是 0', async () => {
    expect(await imageStageProgress('/home', INDEX, 'riscv64', make({}), join)).toBeNull();
  });

  it('⛔ 清单读不到 ⇒ null，不是 0（0 会画成「一直卡在 0%」）', async () => {
    expect(await imageStageProgress('/home', 'sha256:missing', 'arm64', make({}), join)).toBeNull();
  });

  it('一层都还没开始下 ⇒ have=0（那是「确实还没下」，与「测不了」不同）', async () => {
    expect(await imageStageProgress('/home', INDEX, 'arm64', make({}), join)).toEqual({
      have: 0,
      total: 1000,
    });
  });

  it('⛔ 落盘略多于清单声称的量 ⇒ 钳到 size，不许出现 >100%', async () => {
    const got = await imageStageProgress(
      '/home',
      INDEX,
      'arm64',
      make({ 'sha256-L1.tar.gz': 100, 'sha256-L2.tar.gz': 200, 'sha256-BIG.tar.gz': 9999 }),
      join,
    );
    expect(got?.have).toBe(1000);
  });
});
