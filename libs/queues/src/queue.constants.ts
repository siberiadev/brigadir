import type { DefaultJobOptions } from 'bullmq';

/** The reconcile scheduler queue (research F3 — no-op sweeper this iteration). */
export const RECONCILE_QUEUE = 'reconcile';

/** The outbox-reconcile scheduler queue (feature 026, US3 — periodic orphaned-report rescue). */
export const OUTBOX_RECONCILE_QUEUE = 'outbox-reconcile';

/** One queue per executor TYPE: `run.<type>` (iteration 1: `run.mock`). */
export function runQueueName(executorType: string): string {
  return `run.${executorType}`;
}

/**
 * Custom backoff stub (research D3): fixed exponential with jitter. The real
 * error-classification table lands with the claude_cli executor (iteration 2+).
 */
export function backoffStrategy(attemptsMade: number): number {
  const base = Math.min(2 ** attemptsMade * 1000, 30_000);
  const jitter = Math.floor(Math.random() * 1000);
  return base + jitter;
}

/** Default job retention (spec §0.5 verbatim). */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Logical DB index from the URL path (redis://host:port/2). */
  db: number;
  maxRetriesPerRequest: null;
}

/** Build a BullMQ connection from REDIS_URL with the spec's `maxRetriesPerRequest: null`. */
export function buildRedisConnection(
  redisUrl: string = process.env.REDIS_URL ?? 'redis://localhost:6379',
): RedisConnectionOptions {
  const u = new URL(redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password || undefined,
    // Honor the logical DB index from the URL path (redis://host:port/2).
    db: Number(u.pathname.replace(/^\//, '')) || 0,
    // Required by BullMQ for blocking commands (spec §0.5).
    maxRetriesPerRequest: null,
  };
}
