import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxWsEvent } from '@platform/contracts';
import {
  WaitingInputDetector,
  waitingInputSettings,
} from '../../../packages/modules/terminal/src/infrastructure/waiting-input/waiting-input.detector';
import { WaitingInputService } from '../../../packages/modules/terminal/src/application/waiting-input.service';
import { PromptHeuristic } from '../../../packages/modules/terminal/src/domain/services/prompt-heuristic';
import { TerminalOutputBatcher } from '../../../packages/modules/terminal/src/interface/gateway/frame-batcher';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function setup() {
  let time = 0;
  const events: SandboxWsEvent[] = [];
  const detector = new WaitingInputDetector(
    { now: () => new Date(time) },
    { broadcast: (event) => void events.push(event) },
    { silenceSec: 10, promptPatterns: PromptHeuristic.DEFAULT_PATTERNS.map((p) => p.source) },
  );
  return {
    detector,
    query: new WaitingInputService(detector),
    events,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('terminal waiting input observations', () => {
  it('requires output, strictly more than ten seconds of silence, and reports flips only', () => {
    const h = setup();
    h.detector.attach('tty-1', 'sb-1');
    h.advance(11_000);
    h.detector.tick();
    expect(h.query.isWaiting('sb-1')).toBe(false);
    h.detector.output('tty-1', '\u001b[32m❯\u001b[0m ');
    h.advance(10_000);
    h.detector.tick();
    expect(h.events).toEqual([]);
    h.advance(1);
    h.detector.tick();
    h.detector.tick();
    expect(h.query.filterWaiting(['sb-1', 'unattached'])).toEqual(new Set(['sb-1']));
    expect(h.events).toEqual([
      { event: 'sandbox.waiting_input', sandboxId: 'sb-1', waiting: true, sessionId: 'tty-1' },
    ]);
  });

  it('aggregates all attached sessions, resets on input/output, and recalculates on detach', () => {
    const h = setup();
    h.detector.attach('agent', 'sb-1');
    h.detector.attach('shell', 'sb-1');
    h.detector.output('agent', '❯ ');
    h.detector.output('shell', 'Compiling');
    h.advance(11_000);
    h.detector.tick();
    expect(h.query.isWaiting('sb-1')).toBe(false);
    h.detector.output('shell', '\n$ ');
    h.advance(11_000);
    h.detector.tick();
    expect(h.query.isWaiting('sb-1')).toBe(true);
    h.detector.input('agent');
    expect(h.query.isWaiting('sb-1')).toBe(false);
    h.advance(20_000);
    h.detector.tick();
    expect(h.query.isWaiting('sb-1')).toBe(false); // The old answered prompt is not reused.
    h.detector.detach('agent');
    expect(h.query.isWaiting('sb-1')).toBe(true); // The remaining attached shell is waiting.
    h.detector.output('shell', 'ls');
    expect(h.query.isWaiting('sb-1')).toBe(false);
    h.detector.output('shell', '\n$ ');
    h.advance(11_000);
    h.detector.tick();
    h.detector.detach('shell');
    expect(h.query.isWaiting('sb-1')).toBe(false); // No attached TTY never means waiting.
    const flips = h.events.filter((e) => e.event === 'sandbox.waiting_input').map((e) => e.waiting);
    expect(flips).toEqual([true, false, true, false, true, false]);
  });

  it('keeps only the configured 4KB tail and starts a new observer with no historical waiting', () => {
    const h = setup();
    h.detector.attach('tty', 'sb');
    h.detector.output('tty', '❯ \n' + 'x'.repeat(10_000));
    h.advance(11_000);
    h.detector.tick();
    expect(h.query.isWaiting('sb')).toBe(false);
    const observations = Reflect.get(h.detector, 'sessions') as Map<string, { tailBuffer: string }>;
    expect(Buffer.byteLength(observations.get('tty')?.tailBuffer ?? '')).toBeLessThanOrEqual(4096);
    h.detector.output('tty', '\n$ ');
    h.advance(11_000);
    h.detector.tick();
    expect(h.query.isWaiting('sb')).toBe(true);
    expect(setup().query.isWaiting('sb')).toBe(false);
  });

  it('uses one global interval and cancels it along with all observations on shutdown', () => {
    vi.useFakeTimers();
    const h = setup();
    for (let i = 0; i < 100; i += 1) {
      h.detector.attach(String(i), String(i));
      h.detector.output(String(i), '$ ');
    }
    h.detector.onModuleInit();
    expect(vi.getTimerCount()).toBe(1);
    h.advance(11_000);
    vi.advanceTimersByTime(1000);
    expect(h.query.isWaiting('99')).toBe(true);
    h.detector.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.query.filterWaiting(['0', '99'])).toEqual(new Set());
  });

  it('reads deployment thresholds/patterns and rejects invalid configuration', () => {
    vi.stubEnv('TERMINAL_WAITING_INPUT_SILENCE_SEC', '15');
    vi.stubEnv('TERMINAL_PROMPT_PATTERNS', '["^READY$"]');
    expect(waitingInputSettings()).toEqual({ silenceSec: 15, promptPatterns: ['^READY$'] });
    vi.stubEnv('TERMINAL_PROMPT_PATTERNS', '["["]');
    expect(() => waitingInputSettings()).toThrow();
    vi.stubEnv('TERMINAL_WAITING_INPUT_SILENCE_SEC', '0');
    expect(() => waitingInputSettings()).toThrow(/positive/);
  });
});

describe('TTY output batches', () => {
  it('combines within 16ms, preserves UTF-8 across chunks, and cannot send after detach', () => {
    vi.useFakeTimers();
    const frames: string[] = [];
    const batcher = new TerminalOutputBatcher((data) => void frames.push(data));
    const bytes = Buffer.from('❯ ');
    batcher.write(bytes.subarray(0, 1));
    batcher.write(bytes.subarray(1));
    batcher.write(Buffer.from('hello'));
    vi.advanceTimersByTime(15);
    expect(frames).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(frames).toEqual(['❯ hello']);
    batcher.write(Buffer.from('pending'));
    batcher.close();
    batcher.write(Buffer.from('late'));
    vi.advanceTimersByTime(20);
    expect(frames).toEqual(['❯ hello']);
  });
});
