import { describe, it, expect } from 'vitest';
import { sanitizeRateLimitTtl } from './claude-cli-run.processor';

/**
 * Incident 2026-07-19 (kimi/Moonshot). `retry_delay_ms` is whatever the CLI
 * writes into its `api_retry` event — against Moonshot that is the CLI's own
 * jittered client-side backoff, a sub-second FLOAT, not a provider Retry-After.
 * Unsanitized it reached `worker.rateLimit()` → BullMQ `SET ... PX <float>` →
 * Redis "ERR value is not an integer or out of range", which threw instead of
 * `Worker.RateLimitError()`: the park never happened, the attempt was burned,
 * and the run row stayed 'running' forever.
 */
describe('sanitizeRateLimitTtl', () => {
  it('returns an integer for the float the Moonshot-backed CLI reports', () => {
    // The exact value observed in the incident (run 9dfe3f67).
    const ttl = sanitizeRateLimitTtl(577.7599559849516);
    expect(Number.isInteger(ttl)).toBe(true);
  });

  it('floors a sub-second backoff to a real park window', () => {
    // A ~0.5s park is not a park: the job requeues immediately and re-does
    // ~17s of workspace preparation only to hit the same limit — a hot loop.
    expect(sanitizeRateLimitTtl(577.7599559849516)).toBe(60_000);
    expect(sanitizeRateLimitTtl(0)).toBe(60_000);
  });

  it('preserves a genuine subscription window above the floor', () => {
    // The Anthropic shape (existing integration fixture) must be unchanged.
    expect(sanitizeRateLimitTtl(900_000)).toBe(900_000);
  });

  it('rounds a large float UP rather than truncating', () => {
    expect(sanitizeRateLimitTtl(900_000.2)).toBe(900_001);
  });

  it('falls back to the §4 heuristic when no usable value was reported', () => {
    const heuristic = 15 * 60_000;
    expect(sanitizeRateLimitTtl(undefined)).toBe(heuristic);
    expect(sanitizeRateLimitTtl(null)).toBe(heuristic);
    expect(sanitizeRateLimitTtl(NaN)).toBe(heuristic);
    expect(sanitizeRateLimitTtl(Infinity)).toBe(heuristic);
    expect(sanitizeRateLimitTtl('900000')).toBe(heuristic);
  });
});
