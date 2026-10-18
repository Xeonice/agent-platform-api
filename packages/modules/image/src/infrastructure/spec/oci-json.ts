import { isRecord } from '@platform/shared-kernel';
import { ImageSpecError, REGISTRY_UNREACHABLE } from '@platform/contracts';
import type { OciDescriptor, OciImageConfigDoc, OciManifestDoc } from './oci-registry.client';

function invalid(what: string): never {
  throw new ImageSpecError(REGISTRY_UNREACHABLE, `${what} has an invalid OCI JSON structure`);
}
function record(value: unknown, what: string): Record<string, unknown> {
  return isRecord(value) ? value : invalid(what);
}
function text(value: unknown, what: string): string {
  return typeof value === 'string' ? value : invalid(what);
}
function optionalText(value: unknown, what: string): string | undefined {
  return value === undefined ? undefined : text(value, what);
}
function texts(value: unknown, what: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return invalid(what);
  return value.map((item: unknown) => text(item, what));
}
function nullableTexts(value: unknown, what: string): string[] | null | undefined {
  return value === null ? null : texts(value, what);
}
function parseObject(raw: Buffer, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ImageSpecError(REGISTRY_UNREACHABLE, `${what} is not valid JSON`);
  }
  return record(value, what);
}
function descriptor(value: unknown, what: string): OciDescriptor {
  const input = record(value, what);
  const size = input.size;
  if (size !== undefined && (typeof size !== 'number' || !Number.isFinite(size) || size < 0))
    return invalid(what);
  const platform = input.platform === undefined ? undefined : record(input.platform, what);
  return {
    ...input,
    digest: text(input.digest, what),
    mediaType: optionalText(input.mediaType, what),
    size,
    ...(platform === undefined
      ? {}
      : {
          platform: {
            ...platform,
            os: optionalText(platform.os, what),
            architecture: optionalText(platform.architecture, what),
            variant: optionalText(platform.variant, what),
          },
        }),
  };
}

/** Validate consumed fields and retain provider extensions; raw manifest bytes are never rewritten. */
export function parseOciManifest(raw: Buffer, what: string): OciManifestDoc {
  const input = parseObject(raw, what);
  const manifests = input.manifests;
  if (manifests !== undefined && !Array.isArray(manifests)) return invalid(what);
  return {
    ...input,
    mediaType: optionalText(input.mediaType, what),
    ...(input.config === undefined ? {} : { config: descriptor(input.config, what) }),
    ...(manifests === undefined
      ? {}
      : { manifests: manifests.map((item: unknown) => descriptor(item, what)) }),
  };
}

export function parseOciConfig(raw: Buffer, what: string): OciImageConfigDoc {
  const input = parseObject(raw, what);
  const rootfs = input.rootfs === undefined ? undefined : record(input.rootfs, what);
  const config = input.config === undefined ? undefined : record(input.config, what);
  let labels: Record<string, string> | null | undefined;
  let healthcheck: Record<string, unknown> | undefined;
  if (config !== undefined) {
    if (config.Labels === null) labels = null;
    else if (config.Labels !== undefined) {
      labels = Object.fromEntries(
        Object.entries(record(config.Labels, what)).map(([key, value]): [string, string] => [
          key,
          text(value, what),
        ]),
      );
    }
    healthcheck = config.Healthcheck === undefined ? undefined : record(config.Healthcheck, what);
  }
  return {
    ...input,
    architecture: optionalText(input.architecture, what),
    os: optionalText(input.os, what),
    ...(rootfs === undefined
      ? {}
      : {
          rootfs: {
            ...rootfs,
            type: optionalText(rootfs.type, what),
            diff_ids: texts(rootfs.diff_ids, what),
          },
        }),
    ...(config === undefined
      ? {}
      : {
          config: {
            ...config,
            Env: texts(config.Env, what),
            Entrypoint: nullableTexts(config.Entrypoint, what),
            Cmd: nullableTexts(config.Cmd, what),
            WorkingDir: optionalText(config.WorkingDir, what),
            User: optionalText(config.User, what),
            Labels: labels,
            ...(healthcheck === undefined
              ? {}
              : {
                  Healthcheck: {
                    ...healthcheck,
                    Test: texts(healthcheck.Test, what),
                  },
                }),
          },
        }),
  };
}

export function parseOciToken(raw: Buffer, what: string): string | null {
  const input = parseObject(raw, what);
  return optionalText(input.token, what) ?? optionalText(input.access_token, what) ?? null;
}
