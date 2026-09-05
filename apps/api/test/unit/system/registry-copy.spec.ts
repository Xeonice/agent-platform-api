import { describe, expect, it, vi } from 'vitest';
import {
  copyImage,
  isIndex,
  pickPlatformEntry,
  type RegistryCopyPort,
} from '../../../src/platform/system/preset-image/registry-copy';

const CONFIG = 'sha256:cfg';
const L1 = 'sha256:l1';
const L2 = 'sha256:l2';

function manifest(): Buffer {
  return Buffer.from(
    JSON.stringify({
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { digest: CONFIG },
      layers: [{ digest: L1 }, { digest: L2 }],
    }),
  );
}

function index(): Buffer {
  return Buffer.from(
    JSON.stringify({
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        { digest: 'sha256:amd', platform: { os: 'linux', architecture: 'amd64' } },
        { digest: 'sha256:arm', platform: { os: 'linux', architecture: 'arm64' } },
      ],
    }),
  );
}

function port(over: Partial<RegistryCopyPort> = {}): RegistryCopyPort {
  return {
    fetchRawManifest: () =>
      Promise.resolve({
        raw: manifest(),
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: 'sha256:m',
      }),
    hasBlob: () => Promise.resolve(false),
    fetchBlob: () => Promise.resolve(Buffer.from('bytes')),
    putBlob: () => Promise.resolve(),
    putManifest: () => Promise.resolve(),
    ...over,
  };
}

const FROM = { name: 'ghcr.io/x/sandbox', reference: 'v1' };
const TO = { name: 'localhost:5001/platform/sandbox', reference: 'v2' };

describe('copyImage —— config 与 layers 一起搬', () => {
  it('⛔ config 也是 blob，漏了它 manifest 推上去也拉不动', async () => {
    const putBlob = vi.fn((_name: string, _digest: string, _bytes: Buffer) => Promise.resolve());
    const r = await copyImage(port({ putBlob }), FROM, TO, 'arm64');
    expect(r.layers).toBe(3); // config + 2 层
    expect(putBlob.mock.calls.map((c) => c[1])).toEqual([CONFIG, L1, L2]);
  });

  it('⛔ 目标已有的 blob 跳过 —— 一层几百 MB，重推是纯浪费', async () => {
    const fetchBlob = vi.fn((_name: string, _digest: string) => Promise.resolve(Buffer.from('b')));
    const r = await copyImage(
      port({ hasBlob: (_n, d) => Promise.resolve(d === L1), fetchBlob }),
      FROM,
      TO,
      'arm64',
    );
    expect(r.skipped).toBe(1);
    // 跳过的那层**根本没去拉** —— 只跳过 put 而照拉不误等于白费一次下载。
    expect(fetchBlob.mock.calls.map((c) => c[1])).toEqual([CONFIG, L2]);
  });

  it('⛔ manifest **最后**推 —— 先推它会在失败时留下指向不存在的层的 tag', async () => {
    const order: string[] = [];
    await copyImage(
      port({
        putBlob: (_n, d) => {
          order.push(`blob:${d}`);
          return Promise.resolve();
        },
        putManifest: () => {
          order.push('manifest');
          return Promise.resolve();
        },
      }),
      FROM,
      TO,
      'arm64',
    );
    expect(order.at(-1)).toBe('manifest');
    expect(order.filter((o) => o.startsWith('blob:'))).toHaveLength(3);
  });

  it('⛔ 某一层推失败 ⇒ manifest 一个字都不推（宁可没有，不要半张）', async () => {
    const putManifest = vi.fn((_name: string, _ref: string, _raw: Buffer, _mediaType: string) =>
      Promise.resolve(),
    );
    await expect(
      copyImage(
        port({ putBlob: () => Promise.reject(new Error('registry 满了')), putManifest }),
        FROM,
        TO,
        'arm64',
      ),
    ).rejects.toThrow('registry 满了');
    expect(putManifest).not.toHaveBeenCalled();
  });

  it('推的是**原样字节**与原 mediaType（重新序列化会改 digest）', async () => {
    const putManifest = vi.fn((_name: string, _ref: string, _raw: Buffer, _mediaType: string) =>
      Promise.resolve(),
    );
    await copyImage(port({ putManifest }), FROM, TO, 'arm64');
    const call = putManifest.mock.calls[0];
    expect(call).toBeDefined();
    const [name, ref, raw, mt] = call!;
    expect(name).toBe(TO.name);
    expect(ref).toBe(TO.reference);
    expect(raw.equals(manifest())).toBe(true);
    expect(mt).toBe('application/vnd.oci.image.manifest.v1+json');
  });

  it('进度报「第 n / 共 m 层」，且 total 为 0 时不除零', async () => {
    const seen: [number, number][] = [];
    await copyImage(port(), FROM, TO, 'arm64', (d, t) => seen.push([d, t]));
    expect(seen.at(-1)).toEqual([3, 3]);
  });
});

describe('index 压平成单平台', () => {
  it('index ⇒ 先下探到本机架构那一份，再搬它的层', async () => {
    const refs: string[] = [];
    const fetchRawManifest = vi.fn((_n: string, r: string) => {
      refs.push(r);
      return Promise.resolve(
        r === 'v1'
          ? {
              raw: index(),
              mediaType: 'application/vnd.oci.image.index.v1+json',
              digest: 'sha256:i',
            }
          : {
              raw: manifest(),
              mediaType: 'application/vnd.oci.image.manifest.v1+json',
              digest: 'sha256:m',
            },
      );
    });
    await copyImage(port({ fetchRawManifest }), FROM, TO, 'arm64');
    expect(refs).toEqual(['v1', 'sha256:arm']);
  });

  it('⛔ 架构选错会搬一张跑不起来的镜像 —— amd64 宿主要拿 amd64 那份', async () => {
    const refs: string[] = [];
    await copyImage(
      port({
        fetchRawManifest: (_n, r) => {
          refs.push(r);
          return Promise.resolve(
            r === 'v1'
              ? {
                  raw: index(),
                  mediaType: 'application/vnd.oci.image.index.v1+json',
                  digest: 'sha256:i',
                }
              : {
                  raw: manifest(),
                  mediaType: 'application/vnd.oci.image.manifest.v1+json',
                  digest: 'sha256:m',
                },
          );
        },
      }),
      FROM,
      TO,
      'x64',
    );
    expect(refs[1]).toBe('sha256:amd');
  });

  it('index 里没有可用平台 ⇒ 说清楚要的是哪个架构，不静默拿第一个', async () => {
    await expect(
      copyImage(
        port({
          fetchRawManifest: () =>
            Promise.resolve({
              raw: Buffer.from(JSON.stringify({ manifests: [] })),
              mediaType: 'application/vnd.oci.image.index.v1+json',
              digest: 'sha256:i',
            }),
        }),
        FROM,
        TO,
        'arm64',
      ),
    ).rejects.toThrow('arm64');
  });
});

describe('pickPlatformEntry / isIndex', () => {
  it('优先精确匹配，其次任意 linux，最后第一条', () => {
    const doc = JSON.parse(index().toString()) as Parameters<typeof pickPlatformEntry>[0];
    expect(pickPlatformEntry(doc, 'arm64')?.digest).toBe('sha256:arm');
    expect(pickPlatformEntry(doc, 'x64')?.digest).toBe('sha256:amd');
  });

  it('⛔ `unknown/unknown`（attestation 条目）要被排除', () => {
    const doc = {
      manifests: [
        { digest: 'sha256:att', platform: { os: 'unknown', architecture: 'unknown' } },
        { digest: 'sha256:real', platform: { os: 'linux', architecture: 'arm64' } },
      ],
    };
    expect(pickPlatformEntry(doc, 'arm64')?.digest).toBe('sha256:real');
  });

  it.each([
    ['application/vnd.oci.image.index.v1+json', true],
    ['application/vnd.docker.distribution.manifest.list.v2+json', true],
    ['application/vnd.oci.image.manifest.v1+json', false],
  ])('isIndex(%s) = %s', (mt, want) => {
    expect(isIndex(mt)).toBe(want);
  });

  it('带参数的 content-type 也认得（`; charset=utf-8`）', () => {
    expect(isIndex('application/vnd.oci.image.index.v1+json; charset=utf-8')).toBe(true);
  });
});
