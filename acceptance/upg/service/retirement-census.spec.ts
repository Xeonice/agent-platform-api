import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse, type RequestListener } from 'node:http';
import Database from 'better-sqlite3';
import {
  RetirementWorkTracker,
  preparedRetirementRows,
} from '../../../apps/api/src/platform/upgrade/retirement-census';
import { RuntimeOwnerConnection } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-client';
import { SystemClock } from '../../../apps/api/src/platform/time/system-clock';
let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((ok) => server?.close(() => ok()));
    server = undefined;
  }
});
async function listen(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((ok) => server?.listen(0, '127.0.0.1', ok));
  return 'http://127.0.0.1:' + (server.address() as { port: number }).port;
}
describe('retirement census actual lifetimes, no runtime mutation', () => {
  it('keeps work referenced after HTTP close/abort until the actual Promise settles', async () => {
    const tracker = new RetirementWorkTracker();
    let finish: () => void = () => undefined;
    const pending = tracker.run(
      () =>
        new Promise<void>((ok) => {
          finish = ok;
        }),
    );
    const address = await listen((req, res) => {
      tracker.request(req, res);
      res.end('done');
    });
    await fetch(address).then((r) => r.text());
    expect(tracker.snapshot()).toEqual({ http: 0, ws: 0, work: 1 });
    finish();
    await pending;
    expect(tracker.snapshot()).toEqual({ http: 0, ws: 0, work: 0 });
    const close = tracker.begin('ws');
    close();
    close();
    expect(tracker.snapshot().ws).toBe(0);
  });
  it('uses real bounded SQLite participant rows and preserves unknown on overflow/malformed JSON', () => {
    const db = new Database(':memory:');
    try {
      db.exec(
        'CREATE TABLE coordinator_handoffs(candidate,source_generation);CREATE TABLE coordinator_recoveries(candidate,source_generation)',
      );
      const target = {
        startIdentity: 'actual-prepared-fixture',
        artifactDigest: 'sha256:' + 'a'.repeat(64),
        generation: 0,
      };
      expect(preparedRetirementRows(db, target)).toEqual({ handoff: 0, recovery: 0 });
      db.prepare('INSERT INTO coordinator_handoffs VALUES(?,?)').run(JSON.stringify(target), 2);
      expect(preparedRetirementRows(db, target)).toEqual({ handoff: 1, recovery: 0 });
      db.prepare('INSERT INTO coordinator_recoveries VALUES(?,?)').run('{bad', 3);
      expect(preparedRetirementRows(db, target).recovery).toBeNull();
      for (let i = 0; i < 129; i++)
        db.prepare('INSERT INTO coordinator_handoffs VALUES(?,?)').run(JSON.stringify(target), 2);
      expect(preparedRetirementRows(db, target).handoff).toBeNull();
    } finally {
      db.close();
    }
  });
  it('counts actual Owner HTTP body and reconnect retry delay; census itself performs no Owner request', async () => {
    let requests = 0;
    let response: ServerResponse | undefined;
    const address = await listen((req, res) => {
      requests++;
      if (req.url?.startsWith('/runtime/streams/')) {
        res.writeHead(200);
        res.flushHeaders();
        res.end();
      } else {
        response = res;
        res.writeHead(200);
        res.flushHeaders();
      }
    });
    const connection = new RuntimeOwnerConnection({
      endpoint: address,
      instanceId: 'own-census-fixture',
      key: 'synthetic-owner-census-private-key-32',
      generation: 1,
      clock: new SystemClock(),
      deferClaim: true,
    });
    // Read-only metadata; no connect/claim, SDK or Guest is involved.
    const handle = connection.originalHandle('synthetic-sandbox');
    while (!response) await new Promise<void>((ok) => setImmediate(ok));
    expect(connection.transportReferences().http).toBe(1);
    const before = requests;
    connection.transportReferences();
    expect(requests).toBe(before);
    response.end(JSON.stringify({ handle: null }));
    await handle;
    expect(connection.transportReferences().http).toBe(0);
    const abort = new AbortController();
    let unconfirmed: () => void = () => undefined;
    const seen = new Promise<void>((ok) => {
      unconfirmed = ok;
    });
    const reading = (async () => {
      for await (const _ of connection.frames('original-stream', abort.signal, (state) => {
        if (state === 'unconfirmed') unconfirmed();
      })) {
        /* no model/body recording */
      }
    })();
    await seen;
    expect(connection.transportReferences().observers).toBe(1);
    expect(connection.transportReferences().http).toBe(0);
    abort.abort();
    await reading;
    expect(connection.transportReferences()).toEqual({ http: 0, observers: 0, renewals: 0 });
  });
});
