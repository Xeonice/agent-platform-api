import { describe, expect, it } from 'vitest';
import {
  pickAsset,
  planProvision,
  registryAuthorityOf,
  type ProvisionFacts,
  type ReleaseAsset,
} from '../../../src/platform/system/preset-image/provision-plan';

const REF = 'localhost:5001/platform/sandbox:v2';

function facts(over: Partial<ProvisionFacts> = {}): ProvisionFacts {
  return { ref: REF, inLocalDocker: false, asset: null, upstream: null, ...over };
}

const BOXLITE_ARM: ReleaseAsset = {
  id: 'boxlite-sandbox-linux-arm64',
  provider: 'boxlite',
  platform: 'linux/arm64',
  kind: 'oci-layout',
  image: 'ghcr.io/xeonice/cap-boxlite-sandbox:v0.26.0',
  asset: 'cap-boxlite-sandbox-v0.26.0-linux-arm64.oci.tar.zst',
  sha256: 'be2c43cb418dd14797a442aab060e5d88c07940144292c1fff858dc152123e46',
  sizeBytes: 430_725_526,
};
const AIO_AMD: ReleaseAsset = {
  ...BOXLITE_ARM,
  id: 'aio-sandbox-linux-amd64',
  provider: 'aio',
  platform: 'linux/amd64',
  kind: 'docker-archive',
  image: 'ghcr.io/xeonice/cap-aio-sandbox:v0.26.0',
  sizeBytes: 2_074_380_060,
};

describe('planProvision —— 先问「字节够不够得着」', () => {
  it('⛔ 本机 docker 库里有 ⇒ 自己 push，**不是**让用户重新 build（本次事故的根因）', () => {
    const p = planProvision(facts({ inLocalDocker: true }));
    expect(p.source).toBe('local-docker');
    expect(p.provisionable).toBe(true);
    expect(p.why).toContain('不重建');
  });

  it('本机没有但资产清单命中 ⇒ 走资产，体积**原样取清单的数**', () => {
    const p = planProvision(facts({ asset: BOXLITE_ARM }));
    expect(p.source).toBe('release-asset');
    expect(p.provisionable).toBe(true);
    expect(p.sizeBytes).toBe(430_725_526);
    expect(p.asset).toBe(BOXLITE_ARM);
  });

  it('⛔ 本机有 **且** 资产也有 ⇒ 取本机（代价排序：不出网的那条优先）', () => {
    const p = planProvision(facts({ inLocalDocker: true, asset: BOXLITE_ARM }));
    expect(p.source).toBe('local-docker');
  });

  it('前两条都没有、但配了上游 ⇒ upstream-copy（纯 HTTP，不碰 docker）', () => {
    const p = planProvision(facts({ upstream: 'ghcr.io/x/cap-boxlite-sandbox:v0.26.0' }));
    expect(p.source).toBe('upstream-copy');
    expect(p.provisionable).toBe(true);
    expect(p.from).toBe('ghcr.io/x/cap-boxlite-sandbox:v0.26.0');
  });

  it('⛔ 上游排最后不是因为最差，是因为最贵 —— 本机有就不走它', () => {
    expect(planProvision(facts({ inLocalDocker: true, upstream: 'ghcr.io/x/y:1' })).source).toBe(
      'local-docker',
    );
    expect(planProvision(facts({ asset: BOXLITE_ARM, upstream: 'ghcr.io/x/y:1' })).source).toBe(
      'release-asset',
    );
  });

  it('⛔ 上游坐标是空串 ⇒ 当成没配（不许拿空串去拉）', () => {
    expect(planProvision(facts({ upstream: '   ' })).source).toBe('build-only');
  });

  it('三条都没有 ⇒ build-only，且 provisionable 必须是 false（**不许假装能搬**）', () => {
    const p = planProvision(facts());
    expect(p.source).toBe('build-only');
    expect(p.provisionable).toBe(false);
    expect(p.why).toContain('够不着');
    // 说得出**第三条**为什么也不通 —— 否则用户不知道还有配上游这个选项。
    expect(p.why).toContain('SANDBOX_PRESET_IMAGE_SOURCE');
  });

  it('⛔ local-docker 的 sizeBytes 是 null，不许编一个数', () => {
    // 解压后尺寸 ≠ push 传的压缩层字节；给个大一号的数会让进度条一直「差得远」。
    expect(planProvision(facts({ inLocalDocker: true })).sizeBytes).toBeNull();
  });

  it('四条分支两两不同（把任意两格并成一格会在这里红）', () => {
    const s = [
      planProvision(facts({ inLocalDocker: true })).source,
      planProvision(facts({ asset: BOXLITE_ARM })).source,
      planProvision(facts({ upstream: 'ghcr.io/x/y:1' })).source,
      planProvision(facts()).source,
    ];
    expect(new Set(s).size).toBe(4);
  });

  it('每一格都说得出「搬到哪」—— 没有下一步的结论等于没有结论', () => {
    for (const f of [
      facts({ inLocalDocker: true }),
      facts({ asset: BOXLITE_ARM }),
      facts({ upstream: 'ghcr.io/x/y:1' }),
      facts(),
    ]) {
      expect(planProvision(f).to).toBe('localhost:5001');
      expect(planProvision(f).why.length).toBeGreaterThan(10);
    }
  });
});

describe('pickAsset —— provider 与 platform 都要对上', () => {
  it('对上才给', () => {
    expect(pickAsset([BOXLITE_ARM, AIO_AMD], 'boxlite', 'linux/arm64')).toBe(BOXLITE_ARM);
  });

  it('⛔ provider 对、platform 不对 ⇒ 不给（架构不对，push 完才炸，字节白搬）', () => {
    expect(pickAsset([BOXLITE_ARM], 'boxlite', 'linux/amd64')).toBeNull();
  });

  it('⛔ platform 对、provider 不对 ⇒ 不给（两档镜像不可互换，11 §1.3）', () => {
    expect(pickAsset([AIO_AMD], 'boxlite', 'linux/amd64')).toBeNull();
  });

  it('空清单 ⇒ null，不抛', () => {
    expect(pickAsset([], 'boxlite', 'linux/arm64')).toBeNull();
  });
});

describe('registryAuthorityOf —— 与 registryTargetOf 同一条判据', () => {
  it.each([
    ['localhost:5001/platform/sandbox:v2', 'localhost:5001'],
    ['ghcr.io/xeonice/cap-boxlite-sandbox:v0.26.0', 'ghcr.io'],
    ['registry.internal:5000/x/y:1', 'registry.internal:5000'],
    ['localhost/x:1', 'localhost'],
  ])('%s ⇒ %s', (ref, want) => {
    expect(registryAuthorityOf(ref)).toBe(want);
  });

  it('⛔ Docker Hub 短名不许被当成主机名（`alpine` 去 DNS 解析必然失败）', () => {
    expect(registryAuthorityOf('alpine:3.20')).toBe('docker.io');
    expect(registryAuthorityOf('library/alpine')).toBe('docker.io');
  });
});
