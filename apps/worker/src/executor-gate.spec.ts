import { describe, it, expect, vi } from 'vitest';
import { decideGate, parseModelLimits, type GateInputs } from './executor-gate';

/** Base admit case: enabled, well under the profile limit, no model cap. */
function inputs(over: Partial<GateInputs> = {}): GateInputs {
  return {
    profileName: 'p',
    enabled: true,
    maxParallelRuns: 2,
    profileRunning: 0,
    ...over,
  };
}

describe('decideGate — hold reasons', () => {
  it('admits an enabled, under-limit profile with no near-capacity hint', () => {
    expect(decideGate(inputs({ maxParallelRuns: 4, profileRunning: 0 }))).toEqual({ admit: true });
  });

  it('holds a disabled profile (ttl 15000)', () => {
    expect(decideGate(inputs({ enabled: false }))).toEqual({
      admit: false,
      reason: 'disabled',
      ttlMs: 15_000,
      profile: 'p',
    });
  });

  it('holds a saturated profile (at_capacity, ttl 1000)', () => {
    expect(decideGate(inputs({ maxParallelRuns: 2, profileRunning: 2 }))).toEqual({
      admit: false,
      reason: 'at_capacity',
      ttlMs: 1000,
      profile: 'p',
    });
  });

  it('holds a run whose model is at its cap (model_at_capacity, carries profile + model)', () => {
    expect(
      decideGate(
        inputs({ maxParallelRuns: 5, profileRunning: 1, model: 'claude-opus-4-8', modelLimit: 2, modelRunning: 2 }),
      ),
    ).toEqual({
      admit: false,
      reason: 'model_at_capacity',
      ttlMs: 1000,
      profile: 'p',
      model: 'claude-opus-4-8',
    });
  });

  it('ignores the model dimension when no limit is configured, even at high model running', () => {
    // No modelLimit ⇒ no cap; large modelRunning must not hold.
    expect(
      decideGate(inputs({ maxParallelRuns: 5, profileRunning: 0, model: 'claude-opus-4-8', modelRunning: 99 })),
    ).toEqual({ admit: true });
  });

  it('profile check wins over the model check when both are saturated', () => {
    const v = decideGate(
      inputs({ maxParallelRuns: 2, profileRunning: 2, model: 'm', modelLimit: 2, modelRunning: 2 }),
    );
    expect(v).toMatchObject({ admit: false, reason: 'at_capacity' });
  });

  it('honors ttlOverride on every hold reason', () => {
    const o = { ttlOverride: 42 };
    expect(decideGate(inputs({ enabled: false, ...o }))).toMatchObject({ ttlMs: 42 });
    expect(decideGate(inputs({ maxParallelRuns: 1, profileRunning: 1, ...o }))).toMatchObject({ ttlMs: 42 });
    expect(
      decideGate(inputs({ maxParallelRuns: 5, profileRunning: 0, model: 'm', modelLimit: 1, modelRunning: 1, ...o })),
    ).toMatchObject({ ttlMs: 42 });
  });
});

describe('decideGate — nearCapacity hint (post-admit occupancy ≥ 75%)', () => {
  it('fires on the profile dimension when it is tight', () => {
    // running 2 → post-admit 3 of 4 = 75%.
    expect(decideGate(inputs({ maxParallelRuns: 4, profileRunning: 2 }))).toEqual({
      admit: true,
      nearCapacity: { limitKind: 'profile', running: 3, limit: 4 },
    });
  });

  it('fires on the model dimension when it is the tighter one', () => {
    // profile 1/8 post-admit (12.5%), model 3/4 post-admit (75%) → model wins.
    expect(
      decideGate(inputs({ maxParallelRuns: 8, profileRunning: 0, model: 'm', modelLimit: 4, modelRunning: 2 })),
    ).toEqual({ admit: true, nearCapacity: { limitKind: 'model', running: 3, limit: 4 } });
  });

  it('reports the highest-utilization dimension when both qualify', () => {
    // profile 3/4 = 75%, model 4/4 = 100% → model.
    expect(
      decideGate(inputs({ maxParallelRuns: 4, profileRunning: 2, model: 'm', modelLimit: 4, modelRunning: 3 })),
    ).toMatchObject({ nearCapacity: { limitKind: 'model', running: 4, limit: 4 } });
  });

  it('no hint below the threshold', () => {
    // running 1 → post-admit 2 of 4 = 50%.
    expect(decideGate(inputs({ maxParallelRuns: 4, profileRunning: 1 }))).toEqual({ admit: true });
  });

  it('default limit 2 admitting the 2nd run fires (2/2 = 100%)', () => {
    expect(decideGate(inputs({ maxParallelRuns: 2, profileRunning: 1 }))).toEqual({
      admit: true,
      nearCapacity: { limitKind: 'profile', running: 2, limit: 2 },
    });
  });
});

describe('parseModelLimits', () => {
  it('parses a valid model → positive-integer map', () => {
    expect(parseModelLimits('{"claude-opus-4-8":2,"kimi-k2":1}')).toEqual({
      'claude-opus-4-8': 2,
      'kimi-k2': 1,
    });
  });

  it('unset → empty map', () => {
    expect(parseModelLimits(undefined)).toEqual({});
  });

  it('malformed JSON → empty map (warned once)', () => {
    const logger = { warn: vi.fn() };
    // Distinct raw string so warnOnce is not suppressed by an earlier test.
    expect(parseModelLimits('{not json', logger)).toEqual({});
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('non-object JSON → empty map', () => {
    expect(parseModelLimits('[1,2,3]')).toEqual({});
  });

  it('drops non-positive / non-integer / non-numeric entries, keeps the valid ones', () => {
    expect(parseModelLimits('{"a":0,"b":-1,"c":2.5,"d":"x","e":3}')).toEqual({ e: 3 });
  });
});
