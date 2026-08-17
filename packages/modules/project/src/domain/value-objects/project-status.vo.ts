/**
 * Project clone_status value object (docs/backend/23 §6, 03 §7.2). Domain owns its
 * own literal union (does NOT import the wire enum — boundaries forbid
 * domain→contracts); the three layers share the literals by construction.
 *
 *   git  create → cloning → ready | failed
 *   empty create → ready (immediately)
 *   failed → cloning (retry-clone) | ready (convert-to-empty)
 */
export const CLONE_STATUSES = ['cloning', 'ready', 'failed'] as const;
export type CloneStatus = (typeof CLONE_STATUSES)[number];

const TRANSITIONS: Readonly<Record<CloneStatus, readonly CloneStatus[]>> = {
  cloning: ['ready', 'failed'],
  ready: [],
  failed: ['cloning', 'ready'],
};

export const CloneStatusVO = {
  all: CLONE_STATUSES,
  canTransitionTo(from: CloneStatus, to: CloneStatus): boolean {
    return TRANSITIONS[from].includes(to);
  },
};
