import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '@platform/shared-kernel';
import type { ProviderRegistry } from '@platform/contracts';
import { RuntimeOwnerServer } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-server';
import { RuntimeOwnerProviderRegistry } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-client';

const key = 'isolated-owner-handoff-deadline-test-key';
const instanceId = 'isolated-owner-handoff-instance';
const clock: Clock = { now: () => new Date() };
const cleanups: (() => Promise<void>)[] = [];
const emptyProviders: ProviderRegistry = {
  defaultProvider: 'unused',
  get: () => {
    throw new Error('This lease test does not operate a Guest');
  },
  has: () => false,
  list: () => [],
  register: () => {
    throw new Error('This lease test does not register a provider');
  },
};

/** A real HTTP hop can withhold a response body after the actual Owner has
 * committed its journal effect. Releasing that body never cancels the effect. */
async function owner(ownerId: string) {
  const home = await mkdtemp(join(tmpdir(), 'owner-handoff-deadline-'));
  const server = new RuntimeOwnerServer({
    instanceId,
    ownerId,
    key,
    journalPath: join(home, 'owner.sqlite'),
    registry: emptyProviders,
    clock,
  });
  const requests: { method: string; path: string }[] = [];
  server.server.on('request', (req) => {
    requests.push({ method: req.method ?? '', path: req.url ?? '' });
  });
  await server.listen(0);
  const origin = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  let held:
    | { path: string; arrived: () => void; responses: { response: ServerResponse; rest: string }[] }
    | undefined;
  const proxy = createServer((incoming, downstream) => {
    const outgoing = request(
      new URL(incoming.url ?? '/', origin),
      { method: incoming.method, headers: incoming.headers },
      (upstream) => {
        const chunks: Buffer[] = [];
        upstream.on('data', (chunk: Buffer) => chunks.push(chunk));
        upstream.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          downstream.writeHead(upstream.statusCode ?? 500, upstream.headers);
          const blocked = held;
          if (blocked && blocked.path === incoming.url) {
            downstream.write(body.slice(0, 1));
            blocked.responses.push({ response: downstream, rest: body.slice(1) });
            blocked.arrived();
          } else downstream.end(body);
        });
      },
    );
    outgoing.on('error', () => downstream.destroy());
    incoming.pipe(outgoing);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const releaseResponse = () => {
    for (const item of held?.responses ?? []) item.response.end(item.rest);
    held = undefined;
  };
  cleanups.push(async () => {
    releaseResponse();
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await server.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    server,
    requests,
    endpoint,
    block(path: string) {
      let arrive!: () => void;
      const arrived = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      held = { path, arrived: arrive, responses: [] };
      return { arrived, release: releaseResponse };
    },
  };
}

async function registry(
  owners: Awaited<ReturnType<typeof owner>>[],
  deferClaim = false,
): Promise<RuntimeOwnerProviderRegistry> {
  const result = new RuntimeOwnerProviderRegistry();
  cleanups.push(async () => result.onModuleDestroy());
  for (const [i, item] of owners.entries())
    await result.addOwner(
      { endpoint: item.endpoint, instanceId, key, generation: 1, clock, deferClaim },
      i === 0,
    );
  return result;
}

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

describe('RuntimeOwner handoff shares one actual HTTP deadline', () => {
  it('aborts a stalled metadata body before any claim and leaves the prepared connection dormant', async () => {
    const f = await owner('metadata-owner');
    const source = await registry([f]);
    const prepared = await registry([f], true);
    await source.releaseBusinessAuthority();
    const held = f.block('/runtime/metadata');
    const abort = new AbortController();
    let settled = false;
    const work = prepared.activateBusinessAuthority(2, abort.signal).finally(() => {
      settled = true;
    });
    const rejected = expect(work).rejects.toThrow();
    try {
      await held.arrived;
      abort.abort();
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 500 });
      await rejected;
      expect(f.server.journal.lease()?.generation).toBe(1);
      expect(prepared.transportReferences()).toMatchObject({ http: 0, renewals: 0 });
      expect(f.requests.filter((r) => r.path === '/runtime/lease')).toHaveLength(1);
    } finally {
      held.release();
      await rejected;
    }
  });

  it('retains an applied but unconfirmed claim without a late renewal or second claim', async () => {
    const f = await owner('late-claim-owner');
    const source = await registry([f]);
    const prepared = await registry([f], true);
    await source.releaseBusinessAuthority();
    const held = f.block('/runtime/lease');
    const signal = AbortSignal.timeout(100);
    const work = prepared.activateBusinessAuthority(2, signal);
    const rejected = expect(work).rejects.toThrow();
    try {
      await held.arrived;
      expect(f.server.journal.lease()?.generation).toBe(2);
      await rejected;
      expect(signal.aborted).toBe(true);
      held.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(prepared.transportReferences()).toMatchObject({ http: 0, renewals: 0 });
      expect(f.requests.filter((r) => r.path === '/runtime/lease')).toHaveLength(2);
      expect(f.server.journal.lease()?.generation).toBe(2);
    } finally {
      held.release();
      await rejected;
    }
  });

  it('dispatches every Owner concurrently and settles partial claims without compensation', async () => {
    const first = await owner('first-claim-owner');
    const second = await owner('second-claim-owner');
    const source = await registry([first, second]);
    const prepared = await registry([first, second], true);
    await source.releaseBusinessAuthority();
    const firstHeld = first.block('/runtime/lease');
    const secondHeld = second.block('/runtime/lease');
    const abort = new AbortController();
    let settled = false;
    const work = prepared.activateBusinessAuthority(2, abort.signal).finally(() => {
      settled = true;
    });
    const rejected = expect(work).rejects.toThrow();
    try {
      await Promise.all([firstHeld.arrived, secondHeld.arrived]);
      expect(settled).toBe(false);
      firstHeld.release();
      await vi.waitFor(() => expect(prepared.transportReferences().renewals).toBe(1));
      abort.abort();
      await rejected;
      secondHeld.release();
      expect(first.server.journal.lease()?.generation).toBe(2);
      expect(second.server.journal.lease()?.generation).toBe(2);
      expect(prepared.transportReferences()).toMatchObject({ http: 0, renewals: 1 });
      for (const f of [first, second])
        expect(f.requests.filter((r) => r.path === '/runtime/lease')).toHaveLength(2);
    } finally {
      firstHeld.release();
      secondHeld.release();
      await rejected;
    }
  });

  it('stops old renewal at bounded release admission and waits for all actual release results', async () => {
    const first = await owner('first-release-owner');
    const second = await owner('second-release-owner');
    const source = await registry([first, second]);
    const firstHeld = first.block('/runtime/lease/release');
    const secondHeld = second.block('/runtime/lease/release');
    const abort = new AbortController();
    let settled = false;
    const work = source.releaseBusinessAuthority(abort.signal).finally(() => {
      settled = true;
    });
    const rejected = expect(work).rejects.toThrow();
    try {
      expect(source.transportReferences().renewals).toBe(0);
      await Promise.all([firstHeld.arrived, secondHeld.arrived]);
      firstHeld.release();
      await vi.waitFor(() => expect(source.transportReferences().http).toBe(1));
      expect(settled).toBe(false);
      abort.abort();
      await rejected;
      secondHeld.release();
      expect(source.transportReferences()).toMatchObject({ http: 0, renewals: 0 });
      for (const f of [first, second]) {
        expect(f.server.journal.lease()?.leaseExpiresAt).toBe(0);
        expect(f.requests.filter((r) => r.path === '/runtime/lease')).toHaveLength(1);
        expect(f.requests.filter((r) => r.path === '/runtime/lease/release')).toHaveLength(1);
      }
    } finally {
      firstHeld.release();
      secondHeld.release();
      await rejected;
    }
  });

  it('retains an actual sibling HTTP operation after another Owner rejects instead of returning early', async () => {
    const first = await owner('rejecting-claim-owner');
    const second = await owner('pending-claim-owner');
    const source = await registry([first, second]);
    const prepared = await registry([first, second], true);
    await source.connection('pending-claim-owner').release();
    const held = second.block('/runtime/metadata');
    const abort = new AbortController();
    let settled = false;
    const work = prepared.activateBusinessAuthority(2, abort.signal).finally(() => {
      settled = true;
    });
    const rejected = expect(work).rejects.toThrow();
    try {
      await held.arrived;
      await vi.waitFor(() => expect(prepared.transportReferences().http).toBe(1));
      expect(settled).toBe(false);
      expect(first.server.journal.lease()?.generation).toBe(1);
      expect(second.server.journal.lease()?.leaseExpiresAt).toBe(0);
      abort.abort();
      await rejected;
      expect(prepared.transportReferences()).toMatchObject({ http: 0, renewals: 0 });
      expect(first.requests.filter((r) => r.path === '/runtime/lease')).toHaveLength(2);
      expect(second.requests.filter((r) => r.path === '/runtime/lease')).toHaveLength(1);
    } finally {
      held.release();
      await rejected;
    }
  });

  it('does not send an already aborted authority request or stop its existing renewal', async () => {
    const f = await owner('pre-aborted-owner');
    const source = await registry([f]);
    const before = f.requests.length;
    const abort = new AbortController();
    abort.abort();
    await expect(source.activateBusinessAuthority(2, abort.signal)).rejects.toThrow();
    await expect(source.releaseBusinessAuthority(abort.signal)).rejects.toThrow();
    expect(f.requests).toHaveLength(before);
    expect(source.transportReferences()).toMatchObject({ http: 0, renewals: 1 });
    expect(f.server.journal.lease()?.generation).toBe(1);
  });
});
