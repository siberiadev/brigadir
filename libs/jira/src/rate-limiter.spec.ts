import { describe, it, expect } from 'vitest';
import { RateLimiter } from './rate-limiter';
import { JiraRateLimited } from './jira.errors';

describe('RateLimiter (T044)', () => {
  it('throttles beyond the burst to the configured RPS', async () => {
    // burst = 5 tokens; 10 tasks ⇒ 5 immediate, then ~200ms/token for the rest.
    const rl = new RateLimiter({ maxRps: 5, concurrency: 8 });
    const t0 = Date.now();
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 10 }, () =>
        rl.schedule(async () => {
          starts.push(Date.now() - t0);
        }),
      ),
    );
    // The 10th task cannot start before ~ (10-5)/5 s = ~1s after t0.
    const last = Math.max(...starts);
    expect(last).toBeGreaterThanOrEqual(700);
  });

  it('honors a JiraRateLimited delay and retries transparently', async () => {
    const rl = new RateLimiter({ maxRps: 100, concurrency: 8 });
    let calls = 0;
    const t0 = Date.now();
    const result = await rl.schedule(async () => {
      calls += 1;
      if (calls === 1) throw new JiraRateLimited(120, 'per-issue-on-write');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });

  it('never exceeds the concurrency cap', async () => {
    const rl = new RateLimiter({ maxRps: 1000, concurrency: 3 });
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        rl.schedule(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 10));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
  });
});
