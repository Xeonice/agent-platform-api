import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { ImageSpecError } from '@platform/contracts';
import {
  OciRegistryClient,
  parseChallenge,
  splitRegistry,
} from '../../src/infrastructure/spec/oci-registry.client';

/**
 * The WIRE half of the OCI client (04 §7): what it asks for, what it trusts, and how
 * it authenticates. `fetch` is stubbed — this is about the protocol, not about a
 * reachable registry.
 */
const MANIFEST_BODY = JSON.stringify({
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
  config: { digest: 'sha256:cfg', mediaType: 'application/vnd.oci.image.config.v1+json' },
});
const MANIFEST_DIGEST = `sha256:${createHash('sha256').update(MANIFEST_BODY).digest('hex')}`;
const CONFIG_BODY = JSON.stringify({ config: { Labels: { 'platform.tmux': 'true' } } });

interface Call {
  url: string;
  headers: Record<string, string>;
}

let calls: Call[] = [];

function res(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, { status: init.status ?? 200, headers: init.headers });
}

function stubFetch(handler: (url: string, headers: Record<string, string>) => Response): void {
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    return Promise.resolve(handler(url, headers));
  });
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Accept header names BOTH media-type families', () => {
  it('asks for the OCI and the docker manifest AND index types', async () => {
    stubFetch((url) =>
      url.includes('/manifests/')
        ? res(MANIFEST_BODY, { headers: { 'docker-content-digest': MANIFEST_DIGEST } })
        : res(CONFIG_BODY),
    );
    await new OciRegistryClient().fetchManifest('ghcr.io/x/y', 'latest');

    const accept = calls[0].headers.accept;
    // ⚠️ DROPPING EITHER FAMILY IS NOT COSMETIC. A registry that sees only OCI types
    // answers a docker-schema2 image with a 404 or an unusable schema1 blob — i.e. a
    // perfectly good image reads as 「does not exist」. All four are asserted so a
    // 「tidy the header」 edit cannot quietly halve the set.
    expect(accept).toContain('application/vnd.oci.image.manifest.v1+json');
    expect(accept).toContain('application/vnd.oci.image.index.v1+json');
    expect(accept).toContain('application/vnd.docker.distribution.manifest.v2+json');
    expect(accept).toContain('application/vnd.docker.distribution.manifest.list.v2+json');
  });
});

describe('the digest is taken from the header AND verified against the body', () => {
  it('returns the advertised digest when the bytes hash to it', async () => {
    stubFetch((url) =>
      url.includes('/manifests/')
        ? res(MANIFEST_BODY, { headers: { 'docker-content-digest': MANIFEST_DIGEST } })
        : res(CONFIG_BODY),
    );
    const out = await new OciRegistryClient().fetchManifest('ghcr.io/x/y', 'latest');
    expect(out.digest).toBe(MANIFEST_DIGEST);
  });

  it('REFUSES a header that disagrees with the body', async () => {
    // ⚠️ THIS IS THE CLAUSE THAT MAKES 「不可变坐标」 MEAN ANYTHING. A proxy that
    // rewrites the body and keeps the old header would hand us a coordinate for bits
    // we never saw, and every later `ref@digest` pull would fetch something else.
    // Trusting the header alone passes every other test in this file.
    stubFetch((url) =>
      url.includes('/manifests/')
        ? res(MANIFEST_BODY, { headers: { 'docker-content-digest': `sha256:${'0'.repeat(64)}` } })
        : res(CONFIG_BODY),
    );
    await expect(new OciRegistryClient().fetchManifest('ghcr.io/x/y', 'latest')).rejects.toThrow(
      /digest mismatch/i,
    );
  });

  it('falls back to the computed digest when the registry omits the header', async () => {
    stubFetch((url) => (url.includes('/manifests/') ? res(MANIFEST_BODY) : res(CONFIG_BODY)));
    const out = await new OciRegistryClient().fetchManifest('ghcr.io/x/y', 'latest');
    expect(out.digest).toBe(MANIFEST_DIGEST);
  });
});

describe('the Bearer token dance', () => {
  it('reads realm/service/scope from WWW-Authenticate and replays with the token', async () => {
    let issued = false;
    stubFetch((url, headers) => {
      if (url.startsWith('https://auth.example/token')) {
        issued = true;
        return res(JSON.stringify({ token: 'TKN' }));
      }
      if (headers.authorization !== 'Bearer TKN') {
        return res('{}', {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://auth.example/token",service="registry.example",scope="repository:x/y:pull"',
          },
        });
      }
      return url.includes('/manifests/')
        ? res(MANIFEST_BODY, { headers: { 'docker-content-digest': MANIFEST_DIGEST } })
        : res(CONFIG_BODY);
    });

    const out = await new OciRegistryClient().fetchManifest('example.com/x/y', 'latest');
    expect(out.digest).toBe(MANIFEST_DIGEST);
    expect(issued).toBe(true);

    const tokenCall = calls.find((c) => c.url.startsWith('https://auth.example/token'));
    // The service and scope the registry ASKED for, not ones we guessed: ghcr answers
    // a scope-less token request with a token that 401s again.
    expect(tokenCall?.url).toContain('service=registry.example');
    expect(tokenCall?.url).toContain('scope=repository%3Ax%2Fy%3Apull');
  });

  it('parses a challenge into its parameters', () => {
    expect(
      parseChallenge('Bearer realm="https://a/b",service="svc",scope="repository:x:pull"'),
    ).toEqual({ realm: 'https://a/b', service: 'svc', scope: 'repository:x:pull' });
  });
});

describe('failure classification', () => {
  it('404 on the manifest ⇒ REF_NOT_FOUND (IS-02), not a transport error', async () => {
    stubFetch(() => res('{}', { status: 404 }));
    await expect(
      new OciRegistryClient().fetchManifest('ghcr.io/x/nope', 'latest'),
    ).rejects.toMatchObject({ code: 'REF_NOT_FOUND' });
  });

  it('a network fault ⇒ REGISTRY_UNREACHABLE and retryable', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));
    const err = await new OciRegistryClient()
      .fetchManifest('ghcr.io/x/y', 'latest')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageSpecError);
    expect((err as ImageSpecError).code).toBe('REGISTRY_UNREACHABLE');
    // ⚠️ THE ONLY RETRYABLE CODE IN THE IMAGE GROUP, and the reason `resolve` is
    // banned from the create door (10 §6.8).
    expect((err as ImageSpecError).retryable).toBe(true);
  });
});

describe('splitRegistry', () => {
  /**
   * ⭐ **`docker.io` 不是端点，端点是 `registry-1.docker.io`** —— 本地起服务时撞到的真 bug。
   *
   * 简写分支一直知道这件事，但它只在 head「不像 host」时生效。写全限定名时 head 含点，
   * 于是被当成真 host，请求 `https://docker.io/v2/…` 拿回一个 **HTML 页面**，
   * 报出来是 `REGISTRY_UNREACHABLE: manifest … is not valid JSON`。
   *
   * 实测同一张镜像两种写法两个结果：
   *   `alpine:3.20`                   → 422 `IMAGE_BASE_REQUIRED`（正确，被血统拒）
   *   `docker.io/library/alpine:3.20` → 502 `REGISTRY_UNREACHABLE`
   * 而 registry 页面与多数文档显示的正是后一种写法。
   *
   * MUTATION: 删掉 `head === 'docker.io'` 那个分支 ⇒ 本条红（host 退回 `docker.io`）。
   */
  it('`docker.io` / `index.docker.io` 前缀与简写解析到同一个端点', () => {
    const shorthand = splitRegistry('library/alpine');
    for (const spelling of ['docker.io/library/alpine', 'index.docker.io/library/alpine']) {
      expect(splitRegistry(spelling), spelling).toEqual(shorthand);
    }
    // 单段仓库名同样要补 `library/`：`docker.io/alpine` 与 `alpine` 是同一张镜像。
    expect(splitRegistry('docker.io/alpine')).toEqual(splitRegistry('alpine'));
    // 别的 registry 不受影响。
    expect(splitRegistry('ghcr.io/org/img').host).toBe('ghcr.io');
  });
  it.each([
    ['alpine', 'registry-1.docker.io', 'library/alpine'],
    ['library/alpine', 'registry-1.docker.io', 'library/alpine'],
    ['ghcr.io/agent-infra/sandbox', 'ghcr.io', 'agent-infra/sandbox'],
    ['localhost:5001/agent-infra/sandbox', 'localhost:5001', 'agent-infra/sandbox'],
  ])('%s → %s / %s', (name, host, repository) => {
    expect(splitRegistry(name)).toEqual({ host, repository });
  });
});
