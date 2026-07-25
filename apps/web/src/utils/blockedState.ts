import type { BlockedState } from '@brigadir/contracts';

/**
 * Shared blocked_state → tag presentation (feature 022). Single home — used by
 * the workspace Waiting tab and the ticket-history header. cycle is the
 * strongest "will never self-resolve" signal → danger; dead-end / out-of-scope
 * need a human → warning; plain waiting is informational.
 */
export const blockedStateTag: Record<BlockedState, 'info' | 'warning' | 'danger'> = {
  waiting: 'info',
  cycle: 'danger',
  dead_end: 'warning',
  out_of_scope: 'warning',
};

export const blockedStateLabel: Record<BlockedState, string> = {
  waiting: 'Waiting',
  cycle: 'Cycle',
  dead_end: 'Dead end',
  out_of_scope: 'Out of scope',
};

export const blockedStateHint: Record<BlockedState, string> = {
  waiting: 'Blocked by open tickets; starts automatically once they are done.',
  cycle: 'These tickets block each other — break the cycle on the board.',
  dead_end: 'A blocker is closed outside the Done category and will never complete.',
  out_of_scope: 'A blocker is outside this board scope — see the Human queue task.',
};
