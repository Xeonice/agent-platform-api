import { Injectable } from '@nestjs/common';
import type {
  DiagnoseCheckFrame,
  DiagnoseDoneFrame,
  DiagnoseStartFrame,
} from '@platform/contracts';

export interface DiagnosticSnapshot {
  startedAt: string;
  completedAt?: string;
  phase: 'running' | 'completed' | 'aborted';
  start: DiagnoseStartFrame;
  checks: DiagnoseCheckFrame[];
  summary?: DiagnoseDoneFrame;
}

/** The actual latest round in this process. Exporting reads it without starting diagnostics. */
@Injectable()
export class DiagnosticSnapshotService {
  private generation = 0;
  private snapshot?: DiagnosticSnapshot;

  begin(frame: DiagnoseStartFrame, at: Date): number {
    this.snapshot = {
      startedAt: at.toISOString(),
      phase: 'running',
      start: structuredClone(frame),
      checks: [],
    };
    return ++this.generation;
  }
  record(generation: number, frame: DiagnoseCheckFrame): void {
    if (generation !== this.generation || this.snapshot === undefined) return;
    this.snapshot.checks.push(structuredClone(frame));
  }
  finish(generation: number, frame: DiagnoseDoneFrame, at: Date): void {
    if (generation !== this.generation || this.snapshot === undefined) return;
    this.snapshot.phase = 'completed';
    this.snapshot.completedAt = at.toISOString();
    this.snapshot.summary = structuredClone(frame);
  }
  abort(generation: number, at: Date): void {
    if (generation !== this.generation || this.snapshot === undefined) return;
    this.snapshot.phase = 'aborted';
    this.snapshot.completedAt = at.toISOString();
  }
  latest(): DiagnosticSnapshot | undefined {
    return this.snapshot === undefined ? undefined : structuredClone(this.snapshot);
  }
}
