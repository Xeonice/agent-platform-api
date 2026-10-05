import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import { SANDBOX_EVENT_BROADCASTER, type SandboxEventBroadcaster } from '@platform/contracts';
import { WAITING_INPUT_SETTINGS } from '../../domain/ports/waiting-input-observer.port';
import type {
  WaitingInputObserver,
  WaitingInputSettings,
} from '../../domain/ports/waiting-input-observer.port';
import { PromptHeuristic } from '../../domain/services/prompt-heuristic';

interface SessionObservation {
  sandboxId: string;
  lastOutputAt: number;
  tailBuffer: string;
  waiting: boolean;
}

/** One timer for all attached TTYs. Display-only state is never persisted or published to Outbox. */
@Injectable()
export class WaitingInputDetector implements WaitingInputObserver, OnModuleInit, OnModuleDestroy {
  private readonly sessions = new Map<string, SessionObservation>();
  private readonly waitingSandboxes = new Set<string>();
  private readonly heuristic: PromptHeuristic;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SANDBOX_EVENT_BROADCASTER) private readonly broadcaster: SandboxEventBroadcaster,
    @Inject(WAITING_INPUT_SETTINGS) private readonly settings: WaitingInputSettings,
  ) {
    this.heuristic = new PromptHeuristic(
      settings.promptPatterns.map((source) => new RegExp(source)),
    );
  }

  attach(sessionId: string, sandboxId: string): void {
    this.detach(sessionId);
    this.sessions.set(sessionId, {
      sandboxId,
      lastOutputAt: this.clock.now().getTime(),
      tailBuffer: '',
      waiting: false,
    });
    this.recompute(sandboxId, sessionId);
  }

  output(sessionId: string, data: string): void {
    const observation = this.sessions.get(sessionId);
    if (!observation) return;
    observation.lastOutputAt = this.clock.now().getTime();
    const bytes = Buffer.from(observation.tailBuffer + data);
    // 06 §8.1: bounded tail for the last nonempty line, not a scrollback buffer.
    let start = Math.max(0, bytes.length - 4096);
    // Start at a UTF-8 boundary so decoding cannot expand a cut byte into a replacement character.
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
    observation.tailBuffer = bytes.subarray(start).toString('utf8');
    observation.waiting = false;
    this.recompute(observation.sandboxId, sessionId);
  }

  input(sessionId: string): void {
    const observation = this.sessions.get(sessionId);
    if (!observation) return;
    observation.waiting = false;
    observation.lastOutputAt = this.clock.now().getTime();
    // The previously printed prompt was answered; do not re-detect that old prompt on the next tick.
    observation.tailBuffer = '';
    this.recompute(observation.sandboxId, sessionId);
  }

  detach(sessionId: string): void {
    const observation = this.sessions.get(sessionId);
    if (!observation) return;
    this.sessions.delete(sessionId);
    this.recompute(observation.sandboxId, sessionId);
  }

  tick(): void {
    const now = this.clock.now().getTime();
    const changed = new Map<string, string>();
    for (const [id, observation] of this.sessions) {
      if (
        !observation.waiting &&
        now - observation.lastOutputAt > this.settings.silenceSec * 1000 &&
        this.heuristic.looksLikePrompt(observation.tailBuffer)
      ) {
        observation.waiting = true;
        changed.set(observation.sandboxId, id);
      }
    }
    for (const [sandboxId, sessionId] of changed) this.recompute(sandboxId, sessionId);
  }

  isWaiting(sandboxId: string): boolean {
    return this.waitingSandboxes.has(sandboxId);
  }

  filterWaiting(ids: string[]): Set<string> {
    return new Set(ids.filter((id) => this.waitingSandboxes.has(id)));
  }

  private recompute(sandboxId: string, sessionId: string): void {
    const attached = [...this.sessions.values()].filter((s) => s.sandboxId === sandboxId);
    const waiting = attached.length > 0 && attached.every((s) => s.waiting);
    if (waiting === this.waitingSandboxes.has(sandboxId)) return;
    if (waiting) this.waitingSandboxes.add(sandboxId);
    else this.waitingSandboxes.delete(sandboxId);
    this.broadcaster.broadcast({ event: 'sandbox.waiting_input', sandboxId, waiting, sessionId });
  }

  onModuleInit(): void {
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const id of this.sessions.keys()) this.detach(id);
  }
}

/** Deployment configuration; invalid thresholds/regexes fail at boot rather than disabling detection. */
export function waitingInputSettings(): WaitingInputSettings {
  const silenceSec = Number(process.env.TERMINAL_WAITING_INPUT_SILENCE_SEC ?? 10);
  if (!Number.isFinite(silenceSec) || silenceSec <= 0)
    throw new Error('TERMINAL_WAITING_INPUT_SILENCE_SEC must be positive');
  const raw: unknown = process.env.TERMINAL_PROMPT_PATTERNS
    ? JSON.parse(process.env.TERMINAL_PROMPT_PATTERNS)
    : PromptHeuristic.DEFAULT_PATTERNS.map((pattern) => pattern.source);
  if (!Array.isArray(raw) || !raw.every((source): source is string => typeof source === 'string'))
    throw new Error('TERMINAL_PROMPT_PATTERNS must be a JSON array of regex sources');
  for (const source of raw) new RegExp(source);
  return { silenceSec, promptPatterns: raw };
}
