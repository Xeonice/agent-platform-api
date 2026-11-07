import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoordinatorWorker } from '@platform/shared-kernel';
import {
  COORDINATOR_GATEWAY_WORK_FACTORY,
  TERMINAL_AUTHENTICATOR,
  WS_SCHEMA_HASH,
  type ProcessStream,
  type SandboxExecFn,
  type TerminalServerFrame,
} from '@platform/contracts';
import { SqliteUnitOfWork } from '../../../apps/api/src/platform/persistence/unit-of-work.impl';
import { TerminalSessionService } from '../../../packages/modules/terminal/src/application/terminal-session.service';
import { WaitingInputService } from '../../../packages/modules/terminal/src/application/waiting-input.service';
import { SqliteTerminalBookmarks } from '../../../packages/modules/terminal/src/infrastructure/terminal-bookmarks.sqlite';
import { WaitingInputDetector } from '../../../packages/modules/terminal/src/infrastructure/waiting-input/waiting-input.detector';
import { TerminalGateway } from '../../../packages/modules/terminal/src/interface/gateway/terminal.gateway';
import { deferred, unused } from '../../support/strict-ports';

const sandboxId = 'inventory-original-sandbox';
const firstShell = '1'.repeat(32);
const selectedShell = '2'.repeat(32);
type ExecResult = Awaited<ReturnType<SandboxExecFn>>;
const closeFixtures: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closeFixtures.splice(0).reverse()) await close();
});

/** Real migrated SQLite bookmarks, session service, Nest and Socket.IO. Only
 * external tmux/PTY observations are ports; this is not a native Guest proof.
 * No Agent socket is opened: it represents the hidden, unfitted tab on reload. */
async function fixture(
  options: {
    revision?: 1 | 2;
    authorize?: boolean;
    unconfirmed?: boolean;
    delayedInventory?: boolean;
    inventoryFails?: boolean;
  } = {},
) {
  const sqlite = new Database(':memory:');
  migrate(drizzle(sqlite), { migrationsFolder: resolve('drizzle') });
  sqlite
    .prepare(
      "INSERT INTO sandboxes(id,project_id,runtime,status,headless,provider,created_at,updated_at) VALUES(?,?,'claude-code','running',0,'external',0,0)",
    )
    .run(sandboxId, 'inventory-project');
  const bookmarks = new SqliteTerminalBookmarks(
    drizzle(sqlite),
    { next: randomUUID },
    new SqliteUnitOfWork(sqlite),
    { now: () => new Date() },
  );
  const agent = await bookmarks.ensure(sandboxId, 'agent', 'platform-agent');
  const first = await bookmarks.ensure(sandboxId, 'shell', firstShell);
  const selected = await bookmarks.ensure(sandboxId, 'shell', selectedShell);
  for (const bookmark of [agent, first, selected])
    await bookmarks.confirm(sandboxId, bookmark.terminalIdentity, 'original-guest/tmux:321:$2:123');
  const before = sqlite.prepare('SELECT * FROM terminal_bookmarks ORDER BY rowid').all();
  const inventory = deferred<ExecResult>();
  const inventoryResult = {
    exitCode: 0,
    // Deliberately unsorted, including Agent: the real parser filters/sorts it.
    stdout: `platform-shell-${selectedShell}\t20\t\nplatform-agent\t1\t\nplatform-shell-${firstShell}\t10\t\n`,
    stderr: '',
  };
  if (!options.delayedInventory) inventory.resolve(inventoryResult);
  const commands: { sandboxId: string; cmd: string[] }[] = [];
  const ptys: { sandboxId: string; cmd: string[] }[] = [];
  const detach = vi.fn();
  const stream: ProcessStream = {
    ref: 'original-selected-shell-transport',
    runtimeIdentity: options.unconfirmed ? null : 'original-guest',
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    detach,
    onData: (listener) => {
      queueMicrotask(() => listener(Buffer.from('original session output')));
    },
    onExit: () => undefined,
  };
  const sessions = new TerminalSessionService(
    unused('Agent runtime start is forbidden'),
    {
      bindingOf: async () => ({
        sandboxId,
        runtimeId: 'claude-code',
        availableRuntimes: ['claude-code'],
        workdir: '/workspace',
      }),
      execFor: async (requestedSandbox) => async (cmd) => {
        commands.push({ sandboxId: requestedSandbox, cmd });
        if (cmd.includes('list-sessions')) {
          if (options.inventoryFails) throw new Error('External inventory unavailable');
          return inventory.promise;
        }
        if (cmd.includes('display-message'))
          return { exitCode: 0, stdout: '321:$2:123\n', stderr: '' };
        if (cmd.includes('has-session')) return { exitCode: 0, stdout: '', stderr: '' };
        throw new Error('Unexpected external tmux command');
      },
    },
    {
      openPty: async (requestedSandbox, input) => {
        if (!input.cmd)
          throw new Error('The actual session service must specify its attach command');
        ptys.push({ sandboxId: requestedSandbox, cmd: input.cmd });
        return stream;
      },
    },
    bookmarks,
  );
  const waiting = new WaitingInputService(
    new WaitingInputDetector(
      { now: () => new Date() },
      { broadcast: () => undefined },
      { silenceSec: 10, promptPatterns: [] },
    ),
  );
  let worker!: CoordinatorWorker;
  const module = await Test.createTestingModule({
    providers: [
      TerminalGateway,
      { provide: TerminalSessionService, useValue: sessions },
      { provide: WaitingInputService, useValue: waiting },
      {
        provide: TERMINAL_AUTHENTICATOR,
        useValue: { authorize: () => options.authorize !== false },
      },
      {
        provide: COORDINATOR_GATEWAY_WORK_FACTORY,
        useValue: {
          register: (id: string, stop: () => void) => (worker = new CoordinatorWorker(id, stop)),
        },
      },
    ],
  }).compile();
  // WS-only assembly, matching terminal-owner-transport; there are no REST routes.
  const app = module.createNestApplication();
  await app.listen(0, '127.0.0.1');
  const revision = options.revision ?? 2;
  const client: Socket = io((await app.getUrl()) + '/terminal', {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    autoConnect: false,
    query: {
      sandboxId,
      kind: 'shell',
      ...(revision === 2
        ? { protocolMin: '2', protocolMax: '2', terminalIdentity: selected.terminalIdentity }
        : { shellId: selectedShell, xSchemaHash: WS_SCHEMA_HASH }),
    },
  });
  const frames: TerminalServerFrame[] = [];
  const errors: string[] = [];
  client.on('frame', (frame: TerminalServerFrame) => frames.push(frame));
  client.on('connect_error', (error: Error) => errors.push(error.message));
  closeFixtures.push(async () => {
    inventory.resolve(inventoryResult);
    client.disconnect();
    await app.close();
    sqlite.close();
  });
  return {
    client,
    frames,
    errors,
    commands,
    ptys,
    stream,
    detach,
    selected,
    first,
    before,
    rows: () => sqlite.prepare('SELECT * FROM terminal_bookmarks ORDER BY rowid').all(),
    completeInventory: () => inventory.resolve(inventoryResult),
    retire: () => worker.stop(),
    activeWork: () => worker.snapshot().active,
    inventoryCalls: () => commands.filter((call) => call.cmd.includes('list-sessions')),
  };
}

describe('terminal inventory with an inactive Agent tab', () => {
  it('restores both original shell bookmarks from only the selected shell socket, after ready [AC-UPG-003.1]', async () => {
    const f = await fixture({ delayedInventory: true });
    f.client.connect();
    await vi.waitFor(() => expect(f.frames.some((frame) => frame.type === 'ready')).toBe(true));
    expect(f.frames.some((frame) => frame.type === 'shells')).toBe(false);
    expect(f.frames.find((frame) => frame.type === 'ready')).toMatchObject({
      terminalIdentity: f.selected.terminalIdentity,
      runtimeIdentity: 'original-guest/tmux:321:$2:123',
      existingSession: true,
    });
    await vi.waitFor(() => expect(f.inventoryCalls()).toHaveLength(1));
    f.client.emit('frame', { type: 'input', data: 'continue original shell' });
    await vi.waitFor(() => expect(f.stream.write).toHaveBeenCalledWith('continue original shell'));
    expect(f.frames.some((frame) => frame.type === 'shells')).toBe(false);
    f.completeInventory();
    await vi.waitFor(() => expect(f.frames.some((frame) => frame.type === 'shells')).toBe(true));
    expect(f.frames.find((frame) => frame.type === 'shells')).toEqual({
      type: 'shells',
      shells: [
        { shellId: firstShell, terminalIdentity: f.first.terminalIdentity },
        { shellId: selectedShell, terminalIdentity: f.selected.terminalIdentity },
      ],
    });
    expect(f.frames.findIndex((frame) => frame.type === 'ready')).toBeLessThan(
      f.frames.findIndex((frame) => frame.type === 'shells'),
    );
    expect(f.ptys).toHaveLength(1);
    expect(f.ptys[0]?.cmd).toContain(`platform-shell-${selectedShell}`);
    expect(f.ptys[0]?.cmd).toContain('attach');
    expect(f.ptys[0]?.cmd).not.toContain('new-session');
    expect(f.commands.every((call) => call.sandboxId === sandboxId)).toBe(true);
    expect(f.rows()).toEqual(f.before);
    expect(f.stream.kill).not.toHaveBeenCalled();
  });

  it('preserves revision 1 session-first inventory on a shell connection', async () => {
    const f = await fixture({ revision: 1 });
    f.client.connect();
    await vi.waitFor(() => expect(f.frames.some((frame) => frame.type === 'shells')).toBe(true));
    expect(f.frames[0]?.type).toBe('session');
    expect(f.frames.some((frame) => frame.type === 'ready')).toBe(false);
    expect(f.inventoryCalls()).toHaveLength(1);
    expect(f.rows()).toEqual(f.before);
  });

  it('sends null inventory on an external lookup failure without withdrawing ready', async () => {
    const f = await fixture({ inventoryFails: true });
    f.client.connect();
    await vi.waitFor(() => expect(f.frames).toContainEqual({ type: 'shells', shells: null }));
    expect(f.frames.some((frame) => frame.type === 'ready')).toBe(true);
    expect(f.client.connected).toBe(true);
    expect(f.rows()).toEqual(f.before);
  });

  it('does not read or expose sandbox inventory to a rejected handshake', async () => {
    const f = await fixture({ authorize: false });
    f.client.connect();
    await vi.waitFor(() => expect(f.errors).toHaveLength(1));
    expect(f.frames).toEqual([]);
    expect(f.commands).toEqual([]);
    expect(f.ptys).toEqual([]);
    expect(f.rows()).toEqual(f.before);
  });

  it('cannot use a bookmark from another sandbox to obtain its inventory', async () => {
    const f = await fixture();
    f.client.io.opts.query = { ...f.client.io.opts.query, sandboxId: 'different-sandbox' };
    f.client.connect();
    await vi.waitFor(() =>
      expect(f.frames).toContainEqual({
        type: 'error',
        code: 'TERMINAL_GONE',
        sandboxId: 'different-sandbox',
      }),
    );
    expect(f.commands).toEqual([]);
    expect(f.ptys).toEqual([]);
    expect(f.frames.some((frame) => frame.type === 'ready' || frame.type === 'shells')).toBe(false);
    expect(f.rows()).toEqual(f.before);
  });

  it('does not publish inventory before revision 2 physical identity confirmation', async () => {
    const f = await fixture({ unconfirmed: true });
    f.client.connect();
    await vi.waitFor(() =>
      expect(f.frames).toContainEqual({ type: 'error', code: 'RUNTIME_UNKNOWN', sandboxId }),
    );
    expect(f.frames.some((frame) => frame.type === 'ready' || frame.type === 'shells')).toBe(false);
    expect(f.inventoryCalls()).toEqual([]);
    expect(f.rows()).toEqual(f.before);
    expect(f.detach).toHaveBeenCalledOnce();
    expect(f.stream.kill).not.toHaveBeenCalled();
  });

  it('tracks pending inventory through retirement and does not send its late result', async () => {
    const f = await fixture({ delayedInventory: true });
    f.client.connect();
    await vi.waitFor(() => expect(f.frames.some((frame) => frame.type === 'ready')).toBe(true));
    await vi.waitFor(() => expect(f.inventoryCalls()).toHaveLength(1));
    await f.retire();
    await vi.waitFor(() => expect(f.client.disconnected).toBe(true));
    expect(f.activeWork()).toBe(1);
    f.completeInventory();
    await vi.waitFor(() => expect(f.activeWork()).toBe(0));
    await vi.waitFor(() => expect(f.detach).toHaveBeenCalledOnce());
    expect(f.frames.some((frame) => frame.type === 'shells')).toBe(false);
    expect(f.rows()).toEqual(f.before);
    expect(f.stream.kill).not.toHaveBeenCalled();
  });
});
