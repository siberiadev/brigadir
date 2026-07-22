import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { RECONCILE_QUEUE } from '@brigadir/queues';
import {
  ReconcileStatusResponseSchema,
  ReconcileTriggerResponseSchema,
  type ReconcileStatusResponse,
  type ReconcileTriggerResponse,
} from '@brigadir/contracts';

/** Scheduler id, задаваемый воркером (apps/worker/src/reconcile.scheduler.ts). */
const RECONCILE_SCHEDULER_ID = 'reconcile';

/** Сколько последних job'ов смотреть при вычислении last_run_at. */
const LAST_RUN_LOOKBACK = 10;

/**
 * Дашборд-обвязка реконсайл-цикла. Расписание читается из BullMQ-шедулера в
 * Redis (единый источник правды с воркером — env не дублируется), ручной тик —
 * обычный job в RECONCILE_QUEUE: лок-holder обработает его тем же
 * ReconcileProcessor'ом, а без живого воркера job просто ждёт в очереди.
 */
@Injectable()
export class ReconcileService {
  constructor(@InjectQueue(RECONCILE_QUEUE) private readonly queue: Queue) {}

  async status(): Promise<ReconcileStatusResponse> {
    const scheduler = await this.queue.getJobScheduler(RECONCILE_SCHEDULER_ID);

    // last_run_at — max processedOn по недавним active/completed job'ам
    // (removeOnComplete хранит историю; очередь маленькая — тики да ручные).
    const recent = await this.queue.getJobs(['active', 'completed'], 0, LAST_RUN_LOOKBACK - 1);
    const lastProcessedOn = recent.reduce<number | null>(
      (max, job) => (job.processedOn && job.processedOn > (max ?? 0) ? job.processedOn : max),
      null,
    );

    return ReconcileStatusResponseSchema.parse({
      scheduled: scheduler != null,
      every_ms: scheduler?.every ?? null,
      next_run_at: scheduler?.next ? new Date(scheduler.next).toISOString() : null,
      last_run_at: lastProcessedOn ? new Date(lastProcessedOn).toISOString() : null,
      generated_at: new Date().toISOString(),
    });
  }

  async trigger(): Promise<ReconcileTriggerResponse> {
    // Дедуп от даблкликов: ручной тик, который ещё не завершился, не дублируем.
    // Лишний тик и так безопасен (poll & diff идемпотентен), это только гигиена
    // очереди — поэтому обычная проверка, без атомарного dedup-ключа.
    const pending = await this.queue.getJobs(['waiting', 'delayed', 'active']);
    const alreadyQueued = pending.some((job) => job.data?.manual === true);
    if (alreadyQueued) {
      return ReconcileTriggerResponseSchema.parse({ ok: true, deduplicated: true });
    }

    await this.queue.add('reconcile', { manual: true });
    return ReconcileTriggerResponseSchema.parse({ ok: true, deduplicated: false });
  }
}
