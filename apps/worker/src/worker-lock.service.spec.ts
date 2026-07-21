import { afterEach, describe, expect, it } from 'vitest';

import {
  CONTENDER_TTL_MS,
  DEFAULT_WORKER_LOCK_TTL_MS,
  acquireIntervalMs,
  buildIdentity,
  contenderKeyOf,
  formatIdentity,
  renewIntervalMs,
  workerLockKey,
} from './worker-lock.service';

describe('worker-lock pure parts', () => {
  afterEach(() => {
    delete process.env.BRIGADIR_WORKER_MODE;
  });

  it('keys are namespaced by the BullMQ prefix', () => {
    expect(workerLockKey('bull')).toBe('bull:worker-lock');
    expect(workerLockKey('bull-t42')).toBe('bull-t42:worker-lock');
    expect(contenderKeyOf('bull')).toBe('bull:worker-lock:contender');
  });

  it('renewal runs at TTL/3 with a floor for degenerate test TTLs', () => {
    expect(renewIntervalMs(DEFAULT_WORKER_LOCK_TTL_MS)).toBe(5_000);
    expect(renewIntervalMs(3_000)).toBe(1_000);
    expect(renewIntervalMs(60)).toBe(100);
  });

  it('acquire cadence is ~2s at production TTL and proportionally faster below', () => {
    expect(acquireIntervalMs(DEFAULT_WORKER_LOCK_TTL_MS)).toBe(2_000);
    expect(acquireIntervalMs(3_000)).toBe(1_000);
  });

  it('identity carries mode/pid/hostname/acquired_at, mode defaulting to dev', () => {
    const id = buildIdentity({});
    expect(id.mode).toBe('dev');
    expect(id.pid).toBe(process.pid);
    expect(id.hostname.length).toBeGreaterThan(0);
    expect(new Date(id.acquired_at).getTime()).not.toBeNaN();

    const agents = buildIdentity({ BRIGADIR_WORKER_MODE: 'agents' });
    expect(agents.mode).toBe('agents');
  });

  it('formatIdentity is log-friendly and tolerates null', () => {
    const id = buildIdentity({ BRIGADIR_WORKER_MODE: 'agents' });
    expect(formatIdentity(id)).toContain('mode=agents');
    expect(formatIdentity(id)).toContain(`pid=${process.pid}`);
    expect(formatIdentity(null)).toBe('<unknown>');
  });

  it('contender TTL is a fixed contract constant', () => {
    expect(CONTENDER_TTL_MS).toBe(30_000);
  });
});
