import type { Logger } from '@nestjs/common';
import { type BrigadirDb, schema } from '@brigadir/database';

/** run_events.type value for a pre-flight dead-channel hold (feature 026, contracts/run-event-types.md). */
export const CHANNEL_DOWN_EVENT = 'channel_down';

const DEFAULT_CALLBACK_BASE_URL = 'http://127.0.0.1:3000/api/callbacks';
const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const DEFAULT_BASE_TTL_MS = 30_000;
const DEFAULT_MAX_TTL_MS = 300_000;
/** Consecutive failures before the hold is surfaced as an operator alert (Clarification Q3). */
export const ALERT_THRESHOLD = 3;

/**
 * Pre-flight callback-channel probe (feature 026, US4). Before spawning a
 * callback-wired run's agent, the worker probes the callback endpoint's
 * liveness. A dead channel holds the run via the rate-limit path (no attempt
 * burned, run stays `queued`) with exponential backoff, and writes a
 * `channel_down` run-event per failure so the outage is operator-visible.
 *
 * Limitation (stated in the spec): this detects environment-level outages
 * present BEFORE spawn (the 2026-07-19 class: backend down). It cannot detect
 * client-side tool-server bugs or a channel that dies mid-run — the outbox +
 * reconcile paths (US1/US3) cover those.
 *
 * Counters are in-memory only: a worker restart resets backoff (harmless — the
 * persisted `channel_down` trail survives).
 */
export class ChannelProbe {
  private readonly consecutive = new Map<string, number>();

  /** `<BRIGADIR_CALLBACK_BASE_URL or default>/health`, read lazily (Constitution lazy-resolution). */
  healthUrl(): string {
    const base = process.env.BRIGADIR_CALLBACK_BASE_URL ?? DEFAULT_CALLBACK_BASE_URL;
    return `${base.replace(/\/+$/, '')}/health`;
  }

  /** Liveness ⇔ HTTP 2xx within the timeout. Any non-2xx/timeout/network error ⇒ dead. */
  async probe(): Promise<boolean> {
    const timeoutMs = Number(process.env.BRIGADIR_CHANNEL_PROBE_TIMEOUT_MS) || DEFAULT_PROBE_TIMEOUT_MS;
    try {
      const res = await fetch(this.healthUrl(), { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Backoff ladder: base·2^(n-1), capped. Env-overridable so tests can hold briefly. */
  ttlFor(consecutive: number): number {
    const base = Number(process.env.BRIGADIR_CHANNEL_PROBE_BASE_TTL_MS) || DEFAULT_BASE_TTL_MS;
    const cap = Number(process.env.BRIGADIR_CHANNEL_PROBE_MAX_TTL_MS) || DEFAULT_MAX_TTL_MS;
    return Math.min(base * 2 ** (consecutive - 1), cap);
  }

  /** A live channel resets this run's backoff so a recovered run gets its full ladder next time. */
  recordSuccess(runId: string): void {
    this.consecutive.delete(runId);
  }

  /**
   * Record a failed probe: bump the consecutive counter, persist a
   * `channel_down` event, alert-log at/above the threshold, and return the
   * hold TTL for `worker.rateLimit(ttl)`.
   */
  async recordFailure(db: BrigadirDb, runId: string, logger: Logger): Promise<number> {
    const consecutive = (this.consecutive.get(runId) ?? 0) + 1;
    this.consecutive.set(runId, consecutive);
    const ttl = this.ttlFor(consecutive);
    const probeUrl = this.healthUrl();

    await db.insert(schema.runEvents).values({
      runId,
      type: CHANNEL_DOWN_EVENT,
      payload: { probe_url: probeUrl, consecutive, retry_in_ms: ttl },
    });

    const line = `run ${runId}: callback channel probe FAILED (${probeUrl}) — consecutive ${consecutive}, holding ${ttl}ms`;
    if (consecutive >= ALERT_THRESHOLD) {
      logger.error(`${line} [ALERT: channel down ≥${ALERT_THRESHOLD} consecutive probes]`);
    } else {
      logger.warn(line);
    }
    return ttl;
  }
}
