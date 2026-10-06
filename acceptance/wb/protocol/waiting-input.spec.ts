import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProcessStream, SandboxWsEvent, TerminalServerFrame } from '@platform/contracts';
import { asProjectId, asSandboxId } from '@platform/shared-kernel';
import { WaitingInputDetector } from '../../../packages/modules/terminal/src/infrastructure/waiting-input/waiting-input.detector';
import { WaitingInputService } from '../../../packages/modules/terminal/src/application/waiting-input.service';
import { PromptHeuristic } from '../../../packages/modules/terminal/src/domain/services/prompt-heuristic';
import { TerminalGateway } from '../../../packages/modules/terminal/src/interface/gateway/terminal.gateway';
import { TerminalSessionService } from '../../../packages/modules/terminal/src/application/terminal-session.service';
import { SandboxFacadeAdapter } from '../../../packages/modules/sandbox/src/application/sandbox-facade.adapter';
import { Sandbox } from '../../../packages/modules/sandbox/src/domain/entities/sandbox.entity';
import { harness } from '../../support/sandbox-rig';

const children: ChildProcessWithoutNullStreams[] = [];
const gateways: TerminalGateway[] = [];
afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.onModuleDestroy();
  for (const child of children.splice(0)) child.kill();
});

/** Native stdout bytes stand in for the provider's PTY transport; no waiting state is mocked. */
function terminalProcess(): ProcessStream {
  const child = spawn(
    process.execPath,
    [
      '-e',
      String.raw`
    process.stdout.write('\u001b[32m❯\u001b[0m ');
    process.stdin.on('data', (input) => {
      if (input.toString().includes('quit')) process.exit(0);
      process.stdout.write('\nCompiling sources');
    });
  `,
    ],
    { stdio: 'pipe' },
  );
  children.push(child);
  const dataCallbacks: ((chunk: Buffer) => void)[] = [];
  const exitCallbacks: ((code: number | null) => void)[] = [];
  child.stdout.on('data', (chunk: Buffer) => dataCallbacks.forEach((cb) => cb(chunk)));
  child.on('exit', (code) => exitCallbacks.forEach((cb) => cb(code)));
  return {
    ref: `native-${child.pid}`,
    onData: (cb) => void dataCallbacks.push(cb),
    onExit: (cb) => void exitCallbacks.push(cb),
    write: (data) => void child.stdin.write(data),
    resize: () => {
      /* The native stdout fixture has no screen size. */
    },
    detach: () => {
      dataCallbacks.length = 0;
      exitCallbacks.length = 0;
    },
    kill: async () => {
      child.kill();
    },
  };
}

function setup() {
  let time = 0;
  const events: SandboxWsEvent[] = [];
  const detector = new WaitingInputDetector(
    { now: () => new Date(time) },
    { broadcast: (event) => void events.push(event) },
    { silenceSec: 10, promptPatterns: PromptHeuristic.DEFAULT_PATTERNS.map((p) => p.source) },
  );
  const query = new WaitingInputService(detector);
  const h = harness({ waiting: query });
  const facade = new SandboxFacadeAdapter(h.repo, h.registry, h.workspace, h.uow, h.service, query);
  const add = (id: string, headless = false, phase: 'running' | 'idle' | 'pending' = 'running') => {
    const sandbox = Sandbox.create({
      id: asSandboxId(id),
      projectId: asProjectId('prj-1'),
      runtime: 'claude-code',
      provider: h.provider.name,
      imageRef: '',
      headless,
      timeoutMinutes: null,
      idleTimeoutSec: 1800,
      now: h.clock.now(),
    });
    if (phase !== 'pending') {
      sandbox.bindRuntime({ providerSandboxId: `native-${id}`, workspacePath: `/tmp/${id}` });
      for (const state of [
        'scheduling',
        'preparing-workspace',
        'creating',
        'starting',
        'running',
      ] as const)
        sandbox.transitionTo(state, 'scheduler', h.clock.now());
      if (phase === 'idle') sandbox.transitionTo('idle', 'scheduler', h.clock.now());
    }
    h.uow.run((tx) => h.repo.saveSync(tx, sandbox));
    return sandbox;
  };
  const streams: ProcessStream[] = [];
  const sessions = new TerminalSessionService(
    h.runtimes,
    {
      bindingOf: (id) => h.execPort.bindingOf(id),
      execFor: async () => async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    },
    {
      openPty: async () => {
        const stream = terminalProcess();
        streams.push(stream);
        return stream;
      },
    },
  );
  const gateway = new TerminalGateway(sessions, { authorize: () => true }, query);
  gateways.push(gateway);
  const connect = async (id: string, sandboxId: string) => {
    const frames: TerminalServerFrame[] = [];
    const client = {
      id,
      handshake: { query: { sandboxId } },
      request: { socket: { remoteAddress: '127.0.0.1' } },
      emit: (_event: string, frame: TerminalServerFrame) => void frames.push(frame),
      disconnect: () => gateway.handleDisconnect(client as never),
    };
    await gateway.handleConnection(client as never);
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.type === 'data' && frame.data.includes('❯'))).toBe(true),
    );
    return { client, frames };
  };
  return {
    h,
    facade,
    query,
    detector,
    events,
    add,
    connect,
    gateway,
    streams,
    advance: () => {
      time += 11_000;
      detector.tick();
    },
  };
}

describe('native CLI output → terminal observation → sandbox queries', () => {
  it('projects genuine waiting into GET/list/deletion impact without altering persisted lifecycle, and clears on input', async () => {
    const h = setup();
    h.add('interactive');
    h.add('idle-interactive', false, 'idle');
    h.add('headless', true);
    h.add('preparing', false, 'pending');
    const initialVersions = (await h.h.repo.findAll()).map((sandbox) => sandbox.version);
    const terminal = await h.connect('browser-1', 'interactive');
    await h.connect('browser-2', 'idle-interactive');
    await h.connect('browser-3', 'headless');
    h.advance();
    expect(h.query.isWaiting('interactive')).toBe(true);
    expect(h.query.isWaiting('headless')).toBe(false);
    expect(
      h.events.some(
        (event) => event.event === 'sandbox.waiting_input' && event.sandboxId === 'headless',
      ),
    ).toBe(false);
    expect((await h.h.service.get('interactive')).waitingInput).toBe(true);
    expect((await h.h.service.get('interactive')).status).toBe('running');
    expect(
      (await h.h.service.list()).filter((task) => task.waitingInput).map((task) => task.id),
    ).toEqual(['interactive', 'idle-interactive']);
    const impact = await h.facade.credentialImpact('claude-code', [
      'interactive',
      'idle-interactive',
      'headless',
    ]);
    expect(impact.affectedTasks.map((task) => task.status)).toEqual([
      'waiting_input',
      'waiting_input',
      'running',
    ]);
    expect(impact.preparingTasks.map((task) => task.id)).toEqual(['preparing']);
    expect((await h.h.repo.findAll()).map((sandbox) => sandbox.version)).toEqual(initialVersions);
    expect(h.h.provider.calls).toEqual([]);
    expect(
      h.events.filter(
        (event) => event.event === 'sandbox.waiting_input' && event.sandboxId === 'interactive',
      ),
    ).toEqual([expect.objectContaining({ waiting: true })]);
    h.gateway.onFrame(terminal.client as never, { type: 'input', data: 'build\n' });
    expect(h.query.isWaiting('interactive')).toBe(false);
    expect((await h.h.service.get('interactive')).waitingInput).toBe(false);
    expect(
      (await h.facade.credentialImpact('claude-code', ['interactive'])).affectedTasks[0].status,
    ).toBe('running');
    await vi.waitFor(() =>
      expect(
        terminal.frames.some((frame) => frame.type === 'data' && frame.data.includes('Compiling')),
      ).toBe(true),
    );
    h.advance();
    expect(h.query.isWaiting('interactive')).toBe(false);
  });

  it('recomputes all attached real streams on connect, disconnect, and native process exit', async () => {
    const h = setup();
    h.add('task');
    const first = await h.connect('first', 'task');
    h.advance();
    expect(h.query.isWaiting('task')).toBe(true);
    const second = await h.connect('second', 'task');
    expect(h.query.isWaiting('task')).toBe(false);
    h.advance();
    expect(h.query.isWaiting('task')).toBe(true);
    h.gateway.onFrame(second.client as never, { type: 'input', data: 'build\n' });
    expect(h.query.isWaiting('task')).toBe(false);
    h.gateway.handleDisconnect(second.client as never);
    expect(h.query.isWaiting('task')).toBe(true);
    // Exit originates in the native process, not a detector call or client disconnect.
    h.streams[0].write('quit\n');
    await vi.waitFor(() => expect(first.frames.some((frame) => frame.type === 'exit')).toBe(true));
    expect(h.query.isWaiting('task')).toBe(false);
    expect((await h.h.service.get('task')).waitingInput).toBe(false);
  });
});
