import { Inject, Injectable } from '@nestjs/common';
import { desc, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import {
  CHANNEL_HEALTH_AFFECTED_RUNS_CAP,
  ChannelHealthResponseSchema,
  type ChannelHealthResponse,
} from '@brigadir/contracts';
import { createMemoizedArtifactGuard, type MemoizedArtifactGuard } from '@brigadir/executors';

/** Дефолты channel-health (clarify 2026-07-21): окно 15 мин, порог 3. */
const DEFAULT_WINDOW_MS = 15 * 60_000;
const DEFAULT_FAILURE_THRESHOLD = 3;

/**
 * Channel-health агрегат (feature 027, US4 / FR-012). Derived-on-demand из
 * существующих данных: run_events (channel_failure — переливка breadcrumbs,
 * channel_down — pre-flight probe, undelivered_report — 026) + вердикт
 * deployment guard'а, посчитанный ПРЯМО backend'ом (в native-pair режиме
 * backend и worker делят файловую систему; guard — чистая mtime-проверка,
 * мемоизация 10 с). Ничего не хранит, ничего не гейтит: observability-only —
 * admission-контроль остаётся у pre-flight probe (clarify 2026-07-21).
 *
 * degraded ⇔ probe_failures ≥ 1 ИЛИ channel_failures ≥ threshold ИЛИ !guard.ok.
 * Окно/порог — env с ленивым чтением на каждый запрос (Rule 1, дефолты
 * задокументированы в .env.example).
 */
@Injectable()
export class ChannelHealthService {
  private readonly guard: MemoizedArtifactGuard = createMemoizedArtifactGuard();

  constructor(@Inject(DRIZZLE) private readonly db: BrigadirDb) {}

  async aggregate(): Promise<ChannelHealthResponse> {
    const windowMs = readPositiveInt('BRIGADIR_CHANNEL_HEALTH_WINDOW_MS', DEFAULT_WINDOW_MS);
    const threshold = readPositiveInt(
      'BRIGADIR_CHANNEL_HEALTH_FAILURE_THRESHOLD',
      DEFAULT_FAILURE_THRESHOLD,
    );
    const windowStart = new Date(Date.now() - windowMs);

    const [counts] = await this.db
      .select({
        channelFailures: sql<number>`count(*) FILTER (WHERE ${schema.runEvents.type} = 'channel_failure')::int`,
        probeFailures: sql<number>`count(*) FILTER (WHERE ${schema.runEvents.type} = 'channel_down')::int`,
      })
      .from(schema.runEvents)
      .where(sql`${schema.runEvents.createdAt} > ${windowStart}`);

    const [lastSuccess] = await this.db
      .select({ at: sql<string | null>`max(${schema.runEvents.createdAt})` })
      .from(schema.runEvents)
      .where(
        sql`${schema.runEvents.type} = 'progress' AND ${schema.runEvents.payload} ->> 'via' = 'callback'`,
      );

    const affected = await this.db
      .select({
        runId: schema.runEvents.runId,
        lastEventAt: sql<string>`max(${schema.runEvents.createdAt})`.as('last_event_at'),
        ticketKey: sql<string | null>`max(${schema.tickets.jiraKey})`,
      })
      .from(schema.runEvents)
      .leftJoin(schema.runs, sql`${schema.runs.id} = ${schema.runEvents.runId}`)
      .leftJoin(schema.tickets, sql`${schema.tickets.id} = ${schema.runs.ticketId}`)
      .where(
        sql`${schema.runEvents.type} IN ('channel_failure', 'channel_down', 'undelivered_report')
            AND ${schema.runEvents.createdAt} > ${windowStart}`,
      )
      .groupBy(schema.runEvents.runId)
      .orderBy(desc(sql`last_event_at`))
      .limit(CHANNEL_HEALTH_AFFECTED_RUNS_CAP);

    const verdict = await this.guard.check(Date.now());
    const guard = verdict.ok
      ? { ok: true as const, reason: null }
      : { ok: false as const, reason: verdict.reason };

    const degraded =
      counts.probeFailures >= 1 || counts.channelFailures >= threshold || !guard.ok;

    // Схема — строгий контракт; parse здесь ловит рассинхрон на выходе.
    return ChannelHealthResponseSchema.parse({
      status: degraded ? 'degraded' : 'healthy',
      generated_at: new Date().toISOString(),
      window_ms: windowMs,
      failure_threshold: threshold,
      last_successful_callback_at: lastSuccess?.at ? new Date(lastSuccess.at).toISOString() : null,
      channel_failures_in_window: counts.channelFailures,
      probe_failures_in_window: counts.probeFailures,
      deployment_guard: guard,
      affected_runs: affected.map((row) => ({
        run_id: row.runId,
        ticket_key: row.ticketKey ?? null,
        last_event_at: new Date(row.lastEventAt).toISOString(),
      })),
    });
  }
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
