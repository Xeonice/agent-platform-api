import { createHash } from 'node:crypto';
import { ImageSpecError, REF_NOT_FOUND, REGISTRY_UNREACHABLE } from '@platform/contracts';

/**
 * Minimal OCI Distribution v2 client — METADATA ONLY (docs/backend/04 §3 / §7).
 *
 * ⚠️ IT NEVER FETCHES A LAYER, AND THAT CONSTRAINT SHAPES EVERYTHING ELSE. The AIO
 * image is 3.3GB while [验证] has a 60s budget (P21-4 §6), so registration reads the
 * manifest and the CONFIG BLOB (a few KB of JSON: `Env` / `Entrypoint` / `Cmd` /
 * `Labels` / `User` / `WorkingDir`) and stops there. That is also why `validate()`
 * judges DECLARATIONS instead of probing a filesystem — the filesystem is in the
 * layers, and the layers are the thing we refuse to download.
 */

const MANIFEST_ACCEPT = [
  // OCI first — a registry that speaks both should hand us the OCI form.
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  // …and the docker family, because most real registries still answer in it. Omitting
  // either family is not a cosmetic gap: a registry that sees only OCI types in
  // `Accept` answers a docker-schema2 image with 404 or an unusable schema1 blob.
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const INDEX_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

const DOCKER_HUB_HOST = 'registry-1.docker.io';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface OciDescriptor {
  mediaType?: string;
  digest: string;
  size?: number;
  platform?: { os?: string; architecture?: string; variant?: string };
}

export interface OciManifestDoc {
  mediaType?: string;
  config?: OciDescriptor;
  manifests?: OciDescriptor[];
}

export interface OciImageConfigDoc {
  architecture?: string;
  os?: string;
  /**
   * ⚠️ THE LINEAGE ANCHOR, AND IT ARRIVES FOR FREE. `diff_ids` are the hashes of the
   * UNCOMPRESSED layers, in order; a derived image repeats its base's list verbatim
   * and appends. It sits in the SAME config blob we already fetch for `Labels`, so
   * reading it costs zero extra requests and zero layer bytes (04 §3).
   */
  rootfs?: { type?: string; diff_ids?: string[] };
  config?: {
    Env?: string[];
    Entrypoint?: string[] | null;
    Cmd?: string[] | null;
    WorkingDir?: string;
    User?: string;
    Labels?: Record<string, string> | null;
    Healthcheck?: { Test?: string[] };
  };
}

export interface FetchedManifest {
  /**
   * The digest of the object AT THE REFERENCE the user gave us — the index digest
   * when the tag points at a multi-platform index. That is the coordinate we pin,
   * because it is the one a container runtime can pull back.
   */
  digest: string;
  /** Config blob of the platform-specific manifest (already descended if needed). */
  config: OciImageConfigDoc;
}

/** `name` → registry host + repository path (Docker Hub's implicit rules included). */
export function splitRegistry(name: string): { host: string; repository: string } {
  const slash = name.indexOf('/');
  const head = slash < 0 ? '' : name.slice(0, slash);
  // A registry host is anything with a dot, a colon, or the literal `localhost`.
  // Without this test `library/alpine` would read `library` as a host.
  const looksLikeHost = head.includes('.') || head.includes(':') || head === 'localhost';
  if (!looksLikeHost) {
    return { host: DOCKER_HUB_HOST, repository: name.includes('/') ? name : `library/${name}` };
  }
  // ⚠️ **`docker.io` 不是 registry 端点，它是网站。** 端点是 `registry-1.docker.io`。
  //
  // 上面那条简写分支已经知道这件事，但只在 head **不像 host** 时生效；写全限定名
  // （`docker.io/library/alpine:3.20`——registry 页面和多数文档就是这么显示的）时
  // head 含点 ⇒ 被当成真 host ⇒ 请求 `https://docker.io/v2/…` 拿回一个 **HTML 页面**，
  // 报出来是 `REGISTRY_UNREACHABLE: manifest … is not valid JSON`。
  //
  // 实测同一张镜像两种写法两个结果：`alpine:3.20` → 422 `IMAGE_BASE_REQUIRED`（正确），
  // `docker.io/library/alpine:3.20` → 502。docker 自己把这两种写法当同一个，平台也必须。
  // `index.docker.io` 是同一个别名（`docker login` 默认写进 config 的那个）。
  if (head === 'docker.io' || head === 'index.docker.io') {
    const path = name.slice(slash + 1);
    return { host: DOCKER_HUB_HOST, repository: path.includes('/') ? path : `library/${path}` };
  }
  return { host: head, repository: name.slice(slash + 1) };
}

/**
 * 明文 registry 的**允许名单**——`IMAGE_REGISTRY_INSECURE_HOSTS`，逗号分隔的 `host:port`。
 *
 * ⚠️ **为什么必须有这个配置，而不是继续只认 loopback 字面量**（shared/11 §1.4）：
 * `localhost` / `127.0.0.1` 这几个字面量在**容器里指的是容器自己**。于是 compose 形态
 * （api 在容器里）根本配不出一个可用的本机 registry：写 `127.0.0.1:5001` 连的是自己，
 * 换成 `host.docker.internal:5001` 或 compose 服务名又会被这里强制走 https 而失败
 * （实测：`http://host.docker.internal:15001/v2/` → 200，`https://…` → fetch failed）。
 * 这与 `agent-addressing.ts` 记的是**同一个病根**：容器内外的坐标不是同一套。
 *
 * ⇒ 与 docker daemon 自己的 `insecure-registries` 同形状：**部署者显式列出**哪些 host
 * 走明文。⛔ 不做「先试 https 再退回 http」那种自动降级——那等于给任何一次 TLS 故障
 * 配了一条静默的降级路径，而它降级掉的正是传输安全。
 *
 * ⚠️ 默认空 ⇒ 行为与今天一字不差：**只有** loopback 字面量走 http，其余一律 https。
 * ⚠️ 名单比对的是 `host[:port]` 整体：`registry.local:15001` 放行不代表
 * `registry.local:443` 也放行——端口是坐标的一部分。
 */
export function insecureRegistryHosts(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set(
    (env.IMAGE_REGISTRY_INSECURE_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h !== ''),
  );
}

/** Plain HTTP for loopback (the boxlite `:5001` staging mirror) and for hosts the
 * operator explicitly listed as insecure; TLS everywhere else. */
export function schemeFor(host: string, insecure: ReadonlySet<string> = new Set()): string {
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return 'http';
  return insecure.has(host.toLowerCase()) ? 'http' : 'https';
}

export class OciRegistryClient {
  private readonly tokens = new Map<string, string>();

  constructor(
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    /**
     * 明文 registry 允许名单。**构造时定下来**——它是一条部署事实，不是每次请求
     * 各自回答的问题（与 `AgentAddressing` 同理）。
     */
    private readonly insecureHosts: ReadonlySet<string> = insecureRegistryHosts(),
  ) {}

  async fetchManifest(name: string, reference: string): Promise<FetchedManifest> {
    const { host, repository } = splitRegistry(name);
    const base = `${schemeFor(host, this.insecureHosts)}://${host}`;
    const res = await this.authed(
      host,
      repository,
      `${base}/v2/${repository}/manifests/${reference}`,
      MANIFEST_ACCEPT,
    );
    if (res.status === 404) {
      throw new ImageSpecError(REF_NOT_FOUND, `image '${name}:${reference}' not found in registry`);
    }
    if (!res.ok) {
      throw new ImageSpecError(
        REGISTRY_UNREACHABLE,
        `registry ${host} answered ${String(res.status)} for '${repository}:${reference}'`,
      );
    }

    const raw = Buffer.from(await res.arrayBuffer());
    const digest = this.digestOf(res, raw, host);
    const doc = parseJson<OciManifestDoc>(raw, `manifest of ${name}:${reference}`);

    const mediaType = doc.mediaType ?? res.headers.get('content-type') ?? '';
    const target = INDEX_TYPES.has(mediaType.split(';')[0].trim())
      ? await this.descend(base, host, repository, doc, name)
      : doc;

    const configDigest = target.config?.digest;
    if (configDigest === undefined) {
      throw new ImageSpecError(
        REF_NOT_FOUND,
        `manifest of '${name}:${reference}' carries no config descriptor`,
      );
    }
    const config = await this.fetchConfigBlob(base, host, repository, configDigest, name);
    return { digest, config };
  }

  /**
   * Trust, then verify: the registry's `Docker-Content-Digest` is what a runtime will
   * use, but a proxy that rewrites the body and forgets the header would hand us a
   * coordinate for bits we never saw. Both must agree, or this is not a pinnable
   * coordinate at all.
   */
  private digestOf(res: Response, raw: Buffer, host: string): string {
    const computed = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    const advertised = res.headers.get('docker-content-digest');
    if (advertised !== null && advertised !== '' && advertised !== computed) {
      throw new ImageSpecError(
        REGISTRY_UNREACHABLE,
        `digest mismatch from ${host}: header says ${advertised}, body hashes to ${computed}`,
      );
    }
    // A registry that omits the header is still usable — the digest of a manifest is
    // DEFINED as the hash of its bytes, so the computed value is authoritative.
    return advertised !== null && advertised !== '' ? advertised : computed;
  }

  /** An index lists per-platform manifests; pick ours and fetch it BY DIGEST. */
  private async descend(
    base: string,
    host: string,
    repository: string,
    index: OciManifestDoc,
    name: string,
  ): Promise<OciManifestDoc> {
    const entries = (index.manifests ?? []).filter(
      (m) => m.platform?.os !== 'unknown' && m.platform?.architecture !== 'unknown',
    );
    const wantArch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const chosen =
      entries.find((m) => m.platform?.os === 'linux' && m.platform.architecture === wantArch) ??
      entries.find((m) => m.platform?.os === 'linux') ??
      entries[0];
    if (!chosen) {
      throw new ImageSpecError(REF_NOT_FOUND, `image index of '${name}' lists no usable platform`);
    }
    const res = await this.authed(
      host,
      repository,
      `${base}/v2/${repository}/manifests/${chosen.digest}`,
      MANIFEST_ACCEPT,
    );
    if (!res.ok) {
      throw new ImageSpecError(
        REGISTRY_UNREACHABLE,
        `registry ${host} answered ${String(res.status)} for manifest ${chosen.digest}`,
      );
    }
    return parseJson<OciManifestDoc>(
      Buffer.from(await res.arrayBuffer()),
      `platform manifest of ${name}`,
    );
  }

  private async fetchConfigBlob(
    base: string,
    host: string,
    repository: string,
    digest: string,
    name: string,
  ): Promise<OciImageConfigDoc> {
    const res = await this.authed(
      host,
      repository,
      `${base}/v2/${repository}/blobs/${digest}`,
      'application/vnd.oci.image.config.v1+json, application/vnd.docker.container.image.v1+json, application/json',
    );
    if (!res.ok) {
      throw new ImageSpecError(
        REGISTRY_UNREACHABLE,
        `registry ${host} answered ${String(res.status)} for the config blob of '${name}'`,
      );
    }
    return parseJson<OciImageConfigDoc>(
      Buffer.from(await res.arrayBuffer()),
      `config blob of ${name}`,
    );
  }

  /**
   * One request, with the registry Bearer-token dance around it.
   *
   * The v2 API answers an unauthenticated request with `401` +
   * `WWW-Authenticate: Bearer realm="…",service="…",scope="…"`. The client GETs that
   * realm (with the service/scope it was TOLD to ask for — never a guessed one) and
   * replays the request with the returned `token` / `access_token`. Tokens are cached
   * per host+repository because resolve() makes up to three calls per image.
   */
  private async authed(
    host: string,
    repository: string,
    url: string,
    accept: string,
  ): Promise<Response> {
    const key = `${host}/${repository}`;
    const first = await this.send(url, accept, this.tokens.get(key));
    if (first.status !== 401) return first;

    const challenge = first.headers.get('www-authenticate');
    if (challenge === null || !/^Bearer/i.test(challenge)) return first;
    const token = await this.exchange(challenge, host, repository);
    if (token === null) return first;
    this.tokens.set(key, token);
    return this.send(url, accept, token);
  }

  private async exchange(
    challenge: string,
    host: string,
    repository: string,
  ): Promise<string | null> {
    const params = parseChallenge(challenge);
    const realm = params.realm;
    if (realm === undefined) return null;
    const url = new URL(realm);
    if (params.service !== undefined) url.searchParams.set('service', params.service);
    // Fall back to the scope we know we need rather than dropping it: some registries
    // (ghcr) answer a scope-less token request with a token that then 401s again.
    url.searchParams.set('scope', params.scope ?? `repository:${repository}:pull`);

    const headers: Record<string, string> = { accept: 'application/json' };
    const user = process.env.IMAGE_REGISTRY_USERNAME;
    const pass = process.env.IMAGE_REGISTRY_PASSWORD;
    if (user !== undefined && user !== '' && pass !== undefined) {
      headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    }

    const res = await this.send(url.toString(), 'application/json', undefined, headers);
    if (!res.ok) {
      throw new ImageSpecError(
        REGISTRY_UNREACHABLE,
        `token endpoint for ${host} answered ${String(res.status)}`,
      );
    }
    const body = parseJson<{ token?: string; access_token?: string }>(
      Buffer.from(await res.arrayBuffer()),
      `token response from ${host}`,
    );
    return body.token ?? body.access_token ?? null;
  }

  private async send(
    url: string,
    accept: string,
    bearer?: string,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, {
        headers: {
          accept,
          ...(bearer !== undefined ? { authorization: `Bearer ${bearer}` } : {}),
          ...extra,
        },
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (e) {
      // Network faults are `REGISTRY_UNREACHABLE` — retryable, 502, and the ONLY
      // retryable code in this group. Never let it surface as a bare 500.
      throw new ImageSpecError(REGISTRY_UNREACHABLE, describeNetworkError(url, e), e);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** `Bearer realm="https://…",service="x",scope="repository:y:pull"` → a record. */
export function parseChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of header.matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function describeNetworkError(url: string, e: unknown): string {
  const host = safeHost(url);
  if (e instanceof Error && e.name === 'AbortError') {
    return `registry ${host} timed out`;
  }
  return `registry ${host} unreachable: ${e instanceof Error ? e.message : String(e)}`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function parseJson<T>(raw: Buffer, what: string): T {
  try {
    return JSON.parse(raw.toString('utf8')) as T;
  } catch {
    throw new ImageSpecError(REGISTRY_UNREACHABLE, `${what} is not valid JSON`);
  }
}
