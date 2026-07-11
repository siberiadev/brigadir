import { Logger } from '@nestjs/common';
import { JiraRateLimited } from './jira.errors';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export interface RateLimiterOptions {
  /** Sustained requests/sec (token-bucket refill rate + burst size). Default 5. */
  maxRps?: number;
  /** Max in-flight requests. Default 8. */
  concurrency?: number;
  /** Max transparent 429 retries before giving up. Default 8. */
  maxRetries?: number;
}

/**
 * Token bucket + global concurrency cap (contracts.md C4 / research D3).
 *
 * `schedule(fn)` gates every Jira request: it waits for a concurrency slot and a
 * token, then runs `fn`. If `fn` throws `JiraRateLimited` (the client raises it
 * on a 429), the limiter sleeps for the carried delay and retries transparently
 * — a 429 is a pause, never a caller-visible failure (FR-003). Retry-After
 * parsing and the backoff fallback live in the client; the limiter just honors
 * the delay it is handed.
 */
export class RateLimiter {
  private readonly logger = new Logger(RateLimiter.name);
  private readonly maxRps: number;
  private readonly concurrency: number;
  private readonly maxRetries: number;

  private tokens: number;
  private lastRefill = Date.now();
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(opts: RateLimiterOptions = {}) {
    this.maxRps = opts.maxRps ?? 5;
    this.concurrency = opts.concurrency ?? 8;
    this.maxRetries = opts.maxRetries ?? 8;
    this.tokens = this.maxRps;
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      let attempt = 0;
      for (;;) {
        await this.acquireToken();
        try {
          return await fn();
        } catch (err) {
          if (err instanceof JiraRateLimited && attempt < this.maxRetries) {
            attempt += 1;
            this.logger.warn(
              `429 from Jira — waiting ${err.retryAfterMs}ms (attempt ${attempt}${err.reason ? `, reason=${err.reason}` : ''})`,
            );
            await sleep(err.retryAfterMs);
            continue;
          }
          throw err;
        }
      }
    } finally {
      this.releaseSlot();
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxRps, this.tokens + elapsedSec * this.maxRps);
    this.lastRefill = now;
  }

  private async acquireToken(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const neededMs = ((1 - this.tokens) / this.maxRps) * 1000;
      await sleep(neededMs);
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((res) => this.waiters.push(res));
    this.active += 1;
  }

  private releaseSlot(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}
