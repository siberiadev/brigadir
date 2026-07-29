import { describe, it, expect } from 'vitest';
import { sanitizeTimeoutMs, MAX_RUN_TIMEOUT_MS } from './claude-cli-run.processor';

/**
 * Feature 034: `timeout_ms_override` rides the `.passthrough()`
 * TriggerEventSchema, so it is untrusted input — a bogus large value used to
 * arm an unbounded `setTimeout`, silently disabling the per-attempt kill.
 * Small values must pass through EXACTLY: sub-second overrides are how the
 * orphan-process integration fixtures prove a real kill.
 */
describe('sanitizeTimeoutMs', () => {
  const FALLBACK = 45 * 60_000;

  it('passes small test overrides through exactly (150ms / 3000ms fixtures)', () => {
    expect(sanitizeTimeoutMs(150, FALLBACK)).toBe(150);
    expect(sanitizeTimeoutMs(3000, FALLBACK)).toBe(3000);
  });

  it('caps an absurd override at 24h', () => {
    expect(sanitizeTimeoutMs(Date.UTC(2026, 6, 29), FALLBACK)).toBe(MAX_RUN_TIMEOUT_MS);
    expect(sanitizeTimeoutMs(MAX_RUN_TIMEOUT_MS + 1, FALLBACK)).toBe(MAX_RUN_TIMEOUT_MS);
  });

  it('rounds a float up to an integer', () => {
    expect(sanitizeTimeoutMs(1500.4, FALLBACK)).toBe(1501);
  });

  it('falls back on garbage (non-number, non-finite, non-positive)', () => {
    expect(sanitizeTimeoutMs(undefined, FALLBACK)).toBe(FALLBACK);
    expect(sanitizeTimeoutMs(null, FALLBACK)).toBe(FALLBACK);
    expect(sanitizeTimeoutMs('3000', FALLBACK)).toBe(FALLBACK);
    expect(sanitizeTimeoutMs(NaN, FALLBACK)).toBe(FALLBACK);
    expect(sanitizeTimeoutMs(Infinity, FALLBACK)).toBe(FALLBACK);
    expect(sanitizeTimeoutMs(0, FALLBACK)).toBe(FALLBACK);
    expect(sanitizeTimeoutMs(-5, FALLBACK)).toBe(FALLBACK);
  });

  it('clamps even the fallback itself (an operator-set 100000-minute agent budget)', () => {
    expect(sanitizeTimeoutMs(undefined, 100_000 * 60_000)).toBe(MAX_RUN_TIMEOUT_MS);
  });
});
