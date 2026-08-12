import { z } from 'zod';

/**
 * SandboxStatus — the 12 canonical states (docs/backend/13 §2.1 CHECK, 03 §4).
 * Written in state-machine advance order. NOTE: `waiting-input` is NOT here —
 * it is a runtime sub-state of `running`, surfaced only over WS + as a derived
 * DTO field, never persisted (13 §2.1 / 23 I-SBX-8).
 */
export const SANDBOX_STATUSES = [
  'pending',
  'scheduling',
  'preparing-workspace',
  'creating',
  'starting',
  'running',
  'idle',
  'stopping',
  'stopped',
  'failed',
  'destroying',
  'destroyed',
] as const;

export const SandboxStatusSchema = z.enum(SANDBOX_STATUSES);
export type SandboxStatus = z.infer<typeof SandboxStatusSchema>;

/** Who triggered a state transition (13 §2.1.2 CHECK, 5 values). */
export const TRIGGERED_BY = [
  'scheduler',
  'reaper',
  'user',
  'health-check',
  'provider-event',
] as const;

export const TriggeredBySchema = z.enum(TRIGGERED_BY);
export type TriggeredBy = z.infer<typeof TriggeredBySchema>;

/** Headless hard-timeout options in minutes (13 §2.1). Interactive tasks stay null. */
export const TIMEOUT_MINUTES = [30, 60, 120, 240] as const;
export const TimeoutMinutesSchema = z.union([
  z.literal(30),
  z.literal(60),
  z.literal(120),
  z.literal(240),
]);
export type TimeoutMinutes = z.infer<typeof TimeoutMinutesSchema>;
