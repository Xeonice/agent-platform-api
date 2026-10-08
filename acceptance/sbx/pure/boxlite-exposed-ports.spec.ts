import { describe, expect, it } from 'vitest';
import {
  imageExposedPorts,
  imageStageProgress,
} from '../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-image-store';

// The same three-level layout BoxLite 0.9.7 keeps under BOXLITE_HOME/images
// (index -> per-arch manifest -> config), served from memory instead of disk.
const HOME = '/boxlite';
const join = (...parts: string[]) => parts.join('/');
const digest = (n: number) => `sha256:${String(n).repeat(64)}`;
const INDEX = digest(1);
const ARM64 = digest(2);
const AMD64 = digest(3);
const CONFIG = digest(4);
const LAYER = digest(5);
const manifestPath = (d: string) => `${HOME}/images/manifests/${d.replace(':', '-')}.json`;
const configPath = (d: string) => `${HOME}/images/configs/${d.replace(':', '-')}.json`;

function store(config: unknown, overrides: Record<string, string | undefined> = {}) {
  const files: Record<string, string | undefined> = {
    [manifestPath(INDEX)]: JSON.stringify({
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        { digest: AMD64, platform: { architecture: 'amd64', os: 'linux' } },
        { digest: ARM64, platform: { architecture: 'arm64', os: 'linux' } },
      ],
    }),
    [manifestPath(ARM64)]: JSON.stringify({
      config: { digest: CONFIG, size: 1 },
      layers: [{ digest: LAYER, size: 100 }],
    }),
    [configPath(CONFIG)]: JSON.stringify(config),
    [`${HOME}/images/layers/${LAYER.replace(':', '-')}.tar.gz`]: 'x'.repeat(40),
    ...overrides,
  };
  return {
    readFile: async (path: string) => {
      const content = files[path];
      if (content === undefined)
        throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
      return content;
    },
    stat: async (path: string) => {
      const content = files[path];
      if (content === undefined)
        throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
      return { size: content.length };
    },
  };
}
const ports = (config: unknown, overrides?: Record<string, string | undefined>, arch = 'arm64') =>
  imageExposedPorts(HOME, INDEX, arch, store(config, overrides), join);

describe('BoxLite image config decides which guest ports an image declares', () => {
  it.each([
    ['no runtime config at all', { architecture: 'arm64' }],
    ['config without ExposedPorts', { config: { Cmd: ['sleep', 'infinity'] } }],
    ['ExposedPorts null', { config: { ExposedPorts: null } }],
  ])('%s reads as an explicit absence of ports', async (_label, config) => {
    expect(await ports(config)).toEqual([]);
  });

  it('reads a declared tcp port through the per-architecture manifest', async () => {
    expect(await ports({ config: { ExposedPorts: { '8080/tcp': {} } } })).toEqual([
      { port: 8080, protocol: 'tcp' },
    ]);
  });

  it('keeps udp distinct, defaults a bare port to tcp and counts a repeated port once', async () => {
    const declared = await ports({
      config: { ExposedPorts: { '53/udp': {}, '8080': {}, '8080/tcp': {}, '3000/tcp': {} } },
    });
    expect([...(declared ?? [])].sort((a, b) => a.port - b.port)).toEqual([
      { port: 53, protocol: 'udp' },
      { port: 3000, protocol: 'tcp' },
      { port: 8080, protocol: 'tcp' },
    ]);
  });

  it('reads a single-architecture manifest without an index', async () => {
    const fs = store({ config: { ExposedPorts: { '8080/tcp': {} } } });
    expect(await imageExposedPorts(HOME, ARM64, 'arm64', fs, join)).toEqual([
      { port: 8080, protocol: 'tcp' },
    ]);
  });

  it.each(['8000-8010/tcp', 'abc/tcp', '0/tcp', '70000/tcp', '8080/sctp', '8080/TCP'])(
    'an unrecognised key %s makes the whole answer unknown rather than partial',
    async (key) => {
      expect(await ports({ config: { ExposedPorts: { '8080/tcp': {}, [key]: {} } } })).toBeNull();
    },
  );

  it.each([
    ['index missing', { [manifestPath(INDEX)]: undefined }],
    ['platform manifest missing', { [manifestPath(ARM64)]: undefined }],
    ['config blob missing', { [configPath(CONFIG)]: undefined }],
    ['config blob corrupt', { [configPath(CONFIG)]: '{"config":' }],
    ['config blob not an object', { [configPath(CONFIG)]: '[]' }],
    ['config pointer missing', { [manifestPath(ARM64)]: JSON.stringify({ layers: [] }) }],
    [
      'config pointer not an OCI digest',
      {
        [manifestPath(ARM64)]: JSON.stringify({ config: { digest: '../../etc/passwd' } }),
        // A readable config really sits where the unchecked pointer would lead, so only the
        // digest check can make this unknown (not a missing file).
        [`${HOME}/images/configs/../../etc/passwd.json`]: JSON.stringify({
          config: { ExposedPorts: { '8080/tcp': {} } },
        }),
      },
    ],
  ])('%s reads as unknown, never as no ports', async (_label, overrides) => {
    expect(await ports({ config: { ExposedPorts: { '8080/tcp': {} } } }, overrides)).toBeNull();
  });

  it('an index without this host architecture reads as unknown', async () => {
    expect(await ports({ config: {} }, {}, 's390x')).toBeNull();
  });

  it('ExposedPorts of the wrong shape reads as unknown', async () => {
    expect(await ports({ config: { ExposedPorts: ['8080/tcp'] } })).toBeNull();
    expect(await ports({ config: 'oops' })).toBeNull();
  });

  it('stage progress still walks the same index to the same layer list', async () => {
    const fs = store({ config: {} });
    expect(await imageStageProgress(HOME, INDEX, 'arm64', fs, join)).toEqual({
      have: 40,
      total: 100,
    });
    expect(await imageStageProgress(HOME, INDEX, 's390x', fs, join)).toBeNull();
    expect(
      await imageStageProgress(
        HOME,
        INDEX,
        'arm64',
        store({}, { [manifestPath(ARM64)]: undefined }),
        join,
      ),
    ).toBeNull();
  });
});
