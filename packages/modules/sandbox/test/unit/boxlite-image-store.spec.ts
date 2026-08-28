import { describe, it, expect } from 'vitest';
import {
  isImageStaged,
  normaliseStoreReference,
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
