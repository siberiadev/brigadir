import { describe, it, expect } from 'vitest';
import { mapExitStatusToRunStatus } from './status-mapping';

/** T023: exhaustive over exitStatus × outcome (research D4). */
describe('mapExitStatusToRunStatus (T023)', () => {
  const base = { attemptsMade: 0, maxAttempts: 2 };

  it('completed + success → succeeded', () => {
    expect(mapExitStatusToRunStatus({ ...base, exitStatus: 'completed', outcome: 'success' })).toEqual(
      { action: 'finalize', status: 'succeeded' },
    );
  });

  it('completed + failure → failed', () => {
    expect(mapExitStatusToRunStatus({ ...base, exitStatus: 'completed', outcome: 'failure' })).toEqual(
      { action: 'finalize', status: 'failed' },
    );
  });

  it('completed + needs_human → awaiting_human', () => {
    expect(
      mapExitStatusToRunStatus({ ...base, exitStatus: 'completed', outcome: 'needs_human' }),
    ).toEqual({ action: 'finalize', status: 'awaiting_human' });
  });

  it('completed with no valid outcome → failed', () => {
    expect(mapExitStatusToRunStatus({ ...base, exitStatus: 'completed' })).toEqual({
      action: 'finalize',
      status: 'failed',
    });
  });

  it('timeout → timed_out', () => {
    expect(mapExitStatusToRunStatus({ ...base, exitStatus: 'timeout' })).toEqual({
      action: 'finalize',
      status: 'timed_out',
    });
  });

  it('cancelled → cancelled', () => {
    expect(mapExitStatusToRunStatus({ ...base, exitStatus: 'cancelled' })).toEqual({
      action: 'finalize',
      status: 'cancelled',
    });
  });

  it('rate_limited → rate_limit (re-queue)', () => {
    expect(mapExitStatusToRunStatus({ ...base, exitStatus: 'rate_limited' })).toEqual({
      action: 'rate_limit',
    });
  });

  it('crashed with attempts remaining → retry', () => {
    expect(
      mapExitStatusToRunStatus({ exitStatus: 'crashed', attemptsMade: 0, maxAttempts: 2 }),
    ).toEqual({ action: 'retry' });
  });

  it('crashed on the last attempt → failed', () => {
    expect(
      mapExitStatusToRunStatus({ exitStatus: 'crashed', attemptsMade: 1, maxAttempts: 2 }),
    ).toEqual({ action: 'finalize', status: 'failed' });
  });

  it('crashed with maxAttempts=1 fails immediately', () => {
    expect(
      mapExitStatusToRunStatus({ exitStatus: 'crashed', attemptsMade: 0, maxAttempts: 1 }),
    ).toEqual({ action: 'finalize', status: 'failed' });
  });
});
